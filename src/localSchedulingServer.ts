import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DateTime } from 'luxon';
import { defaultSchedulingPreference, type BusyInterval } from './calendar/service.js';
import { FakeCalendarService } from './calendar/fake.js';
import { CafeRepository, migrate, openDatabase, type SqliteDatabase } from './db.js';
import { createLogger } from './logger.js';
import { MockSchedulingEnvironment, SchedulingCoordinator } from './scheduling.js';
import type { MatchRecord, RuntimeConfig, SchedulingCandidateSlot, SchedulingPreference, SchedulingRequest } from './types.js';

const USERS = ['U1', 'U2'] as const;
type LocalUserId = (typeof USERS)[number];

interface LogEntry {
  at: string;
  who: 'bot' | 'system' | LocalUserId;
  text: string;
}

interface LocalState {
  match: MatchRecord;
  request: SchedulingRequest | null;
  selectedSlot: SchedulingCandidateSlot | null;
  activeSlots: SchedulingCandidateSlot[];
  preferences: Record<LocalUserId, SchedulingPreference>;
  responses: unknown[];
  messages: unknown[];
  notifications: unknown[];
  createdEvent: unknown | null;
  busy: Record<LocalUserId, BusyInterval[]>;
  log: LogEntry[];
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function localRuntimeConfig(): RuntimeConfig {
  return {
    slackBotToken: 'xoxb-local-test',
    slackAppToken: 'xapp-local-test',
    adminUserIds: new Set(['LOCAL_ADMIN']),
    databasePath: ':memory:',
    logLevel: 'silent',
    schedulerIntervalSeconds: 60,
    maxParticipants: 200,
    matchCandidateAttempts: 200,
    maxRemindersPerMatch: 2,
    calendarSchedulingEnabled: true,
    calendarProvider: 'fake',
    calendarDefaultDurationMinutes: envInt('CALENDAR_DEFAULT_DURATION_MINUTES', 30),
    calendarSearchHorizonDays: envInt('CALENDAR_SEARCH_HORIZON_DAYS', 7),
    calendarMinimumNoticeHours: envInt('CALENDAR_MINIMUM_NOTICE_HOURS', 24),
    calendarDefaultPreferredStart: process.env.CALENDAR_DEFAULT_PREFERRED_START ?? '10:00',
    calendarDefaultPreferredEnd: process.env.CALENDAR_DEFAULT_PREFERRED_END ?? '17:00',
    calendarAgentFallbackMode: process.env.CALENDAR_AGENT_FALLBACK_MODE === 'failed' ? 'failed' : 'manual',
    piProvider: process.env.PI_PROVIDER ?? 'deepseek',
    piModel: process.env.PI_MODEL ?? 'deepseek-v4-flash',
    piAgentTimeoutMs: envInt('PI_AGENT_TIMEOUT_MS', 60_000),
  };
}

class LocalSchedulingHarness {
  readonly config = localRuntimeConfig();
  db: SqliteDatabase;
  repository: CafeRepository;
  calendar: FakeCalendarService;
  environment: MockSchedulingEnvironment;
  coordinator: SchedulingCoordinator;
  match: MatchRecord;
  private seenMessageIds = new Set<number>();
  private log: LogEntry[] = [];
  private busyByUser: Record<LocalUserId, BusyInterval[]> = { U1: [], U2: [] };

  constructor() {
    const initialized = this.initialize();
    this.db = initialized.db;
    this.repository = initialized.repository;
    this.calendar = initialized.calendar;
    this.environment = initialized.environment;
    this.coordinator = initialized.coordinator;
    this.match = initialized.match;
  }

  reset(): LocalState {
    this.db.close();
    this.busyByUser = { U1: [], U2: [] };
    const initialized = this.initialize();
    this.db = initialized.db;
    this.repository = initialized.repository;
    this.calendar = initialized.calendar;
    this.environment = initialized.environment;
    this.coordinator = initialized.coordinator;
    this.match = initialized.match;
    this.seenMessageIds = new Set();
    this.log = [];
    this.addLog('system', 'Reset local fake coffee match U1 ↔ U2.');
    return this.state();
  }

  close(): void {
    this.db.close();
  }

  async propose(): Promise<LocalState> {
    if (!this.request()) this.coordinator.createRequestForMatch(this.match);
    this.addLog('system', 'Bot is planning with fake calendars + real Pi agent...');
    await this.coordinator.processPendingRequests('2026-06-01T08:00:00Z');
    this.syncBotMessages();
    this.addRequestSummary();
    return this.state();
  }

  async sendMessage(userId: string, text: string): Promise<LocalState> {
    const user = asLocalUser(userId);
    const request = this.ensureRequest();
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Message is empty');
    this.addLog(user, trimmed);
    await this.coordinator.handleParticipantResponse({ requestId: request.id, userId: user, response: 'text_preference', text: trimmed }, '2026-06-01T09:00:00Z');
    this.syncBotMessages();
    this.addRequestSummary();
    return this.state();
  }

  async accept(userId: string, slotIds: string[] = []): Promise<LocalState> {
    const user = asLocalUser(userId);
    const request = this.ensureRequest();
    const selected = [...new Set(slotIds)]
      .map((slotId) => this.repository.getCandidateSlot(request.id, slotId))
      .filter((slot): slot is SchedulingCandidateSlot => Boolean(slot && slot.status === 'active'));
    if (selected.length === 0) throw new Error('Select at least one active proposed slot');
    this.addLog(user, `Can do: ${selected.map(formatSlot).join('; ')}.`);
    await this.coordinator.handleParticipantResponse({ requestId: request.id, userId: user, response: 'accepted', slotIds: selected.map((slot) => slot.id) }, '2026-06-01T09:01:00Z');
    this.syncBotMessages();
    this.addRequestSummary();
    return this.state();
  }

  async manual(userId: string): Promise<LocalState> {
    const user = asLocalUser(userId);
    const request = this.ensureRequest();
    this.addLog(user, 'Switches this match to manual scheduling.');
    await this.coordinator.handleParticipantResponse({ requestId: request.id, userId: user, response: 'manual' }, '2026-06-01T09:02:00Z');
    this.syncBotMessages();
    this.addRequestSummary();
    return this.state();
  }

  async savePreferences(input: Record<string, unknown>): Promise<LocalState> {
    const user = asLocalUser(String(input.userId ?? ''));
    const current = this.repository.getSchedulingPreference(user) ?? defaultSchedulingPreference(user, this.config, '2026-06-01T08:00:00Z');
    const preference: SchedulingPreference = {
      ...current,
      preferredStart: stringOr(input.preferredStart, current.preferredStart),
      preferredEnd: stringOr(input.preferredEnd, current.preferredEnd),
      durationMinutes: positiveNumber(input.durationMinutes, current.durationMinutes),
      searchHorizonDays: positiveNumber(input.searchHorizonDays, current.searchHorizonDays),
      minNoticeHours: nonNegativeNumber(input.minNoticeHours, current.minNoticeHours),
      automatedSchedulingEnabled: input.automatedSchedulingEnabled === false ? false : current.automatedSchedulingEnabled,
      updatedAt: '2026-06-01T08:00:00Z',
    };
    assertTime(preference.preferredStart, 'preferredStart');
    assertTime(preference.preferredEnd, 'preferredEnd');
    if (minutesOf(preference.preferredStart) >= minutesOf(preference.preferredEnd)) throw new Error('preferredEnd must be later than preferredStart');
    this.repository.saveSchedulingPreference(preference, '2026-06-01T08:00:00Z');
    this.addLog('system', `${user} preferences saved: ${preference.preferredStart}–${preference.preferredEnd}, ${preference.durationMinutes} min.`);

    const request = this.request();
    if (request && !terminal(request.status)) {
      await this.coordinator.handleParticipantResponse({ requestId: request.id, userId: user, response: 'alternatives', text: 'Structured preferences updated' }, '2026-06-01T09:03:00Z');
      this.syncBotMessages();
      this.addRequestSummary();
    }
    return this.state();
  }

  async blockBusySlot(input: Record<string, unknown>): Promise<LocalState> {
    const user = asLocalUser(String(input.userId ?? ''));
    const date = stringOr(input.date, '');
    const time = stringOr(input.time, '');
    assertTime(time, 'busy time');
    const [hour, minute] = time.split(':').map(Number);
    if (minute !== 0 && minute !== 30) throw new Error('busy time must start on a 00 or 30 minute boundary');
    const starts = DateTime.fromISO(`${date}T${time}`, { zone: 'Europe/Berlin' });
    if (!starts.isValid) throw new Error('busy date must be YYYY-MM-DD');
    const ends = starts.plus({ minutes: 30 });
    const interval = {
      startsAt: starts.toUTC().toISO({ suppressMilliseconds: true })!,
      endsAt: ends.toUTC().toISO({ suppressMilliseconds: true })!,
    };
    if (!this.busyByUser[user].some((item) => item.startsAt === interval.startsAt && item.endsAt === interval.endsAt)) {
      this.busyByUser[user].push(interval);
      this.busyByUser[user].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
    }
    this.calendar.setBusy(user, this.busyByUser[user]);
    this.addLog('system', `${user} is busy ${formatBusyInterval(interval)}.`);
    await this.replanAfterCalendarChange(user, 'Calendar busy slot added');
    return this.state();
  }

  async removeBusySlot(input: Record<string, unknown>): Promise<LocalState> {
    const user = asLocalUser(String(input.userId ?? ''));
    const startsAt = String(input.startsAt ?? '');
    const before = this.busyByUser[user].length;
    this.busyByUser[user] = this.busyByUser[user].filter((item) => item.startsAt !== startsAt);
    this.calendar.setBusy(user, this.busyByUser[user]);
    if (this.busyByUser[user].length !== before) {
      this.addLog('system', `${user} busy slot removed.`);
      await this.replanAfterCalendarChange(user, 'Calendar busy slot removed');
    }
    return this.state();
  }

  async toggleBusySlot(input: Record<string, unknown>): Promise<LocalState> {
    const user = asLocalUser(String(input.userId ?? ''));
    const interval = intervalFromLocalInput(input);
    const existing = this.busyByUser[user].some((item) => sameInterval(item, interval));
    if (existing) {
      this.busyByUser[user] = this.busyByUser[user].filter((item) => !sameInterval(item, interval));
      this.addLog('system', `${user} opened ${formatBusyInterval(interval)}.`);
      this.calendar.setBusy(user, this.busyByUser[user]);
      await this.replanAfterCalendarChange(user, 'Calendar busy slot removed');
    } else {
      this.busyByUser[user].push(interval);
      this.busyByUser[user].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
      this.addLog('system', `${user} is busy ${formatBusyInterval(interval)}.`);
      this.calendar.setBusy(user, this.busyByUser[user]);
      await this.replanAfterCalendarChange(user, 'Calendar busy slot added');
    }
    return this.state();
  }

  async shuffleBusySlots(input: Record<string, unknown>): Promise<LocalState> {
    const user = asLocalUser(String(input.userId ?? ''));
    const count = positiveNumber(input.count, 0);
    if (count <= 0) throw new Error('Shuffle count must be positive');
    const candidates = weekIntervals(
      stringOr(input.weekStart, '2026-06-01'),
      stringOr(input.startTime, '10:00'),
      stringOr(input.endTime, '17:00'),
    ).filter((candidate) => !this.busyByUser[user].some((busy) => sameInterval(busy, candidate)));
    shuffle(candidates);
    const picked = candidates.slice(0, count);
    this.busyByUser[user].push(...picked);
    this.busyByUser[user].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
    this.calendar.setBusy(user, this.busyByUser[user]);
    this.addLog('system', `${user} randomly closed ${picked.length} slot(s) this week.`);
    await this.replanAfterCalendarChange(user, 'Calendar busy slots shuffled');
    return this.state();
  }

  async clearBusySlots(input: Record<string, unknown>): Promise<LocalState> {
    const user = asLocalUser(String(input.userId ?? ''));
    const removed = this.busyByUser[user].length;
    this.busyByUser[user] = [];
    this.calendar.setBusy(user, []);
    this.addLog('system', `${user} cleared ${removed} busy slot(s).`);
    await this.replanAfterCalendarChange(user, 'Calendar busy slots cleared');
    return this.state();
  }

  state(): LocalState {
    const request = this.request();
    const selectedSlot = this.selectedSlot();
    const activeSlots = request ? this.repository.listCandidateSlots(request.id, 'active') : [];
    const messages = request ? this.repository.listSchedulingMessages(request.id) : [];
    const responses = request ? this.repository.listSchedulingResponses(request.id) : [];
    const createdEvent = request && selectedSlot ? this.calendar.getCreatedEvent(`${request.id}:${selectedSlot.id}`) ?? null : null;
    return {
      match: this.match,
      request,
      selectedSlot,
      activeSlots,
      preferences: {
        U1: this.repository.getSchedulingPreference('U1')!,
        U2: this.repository.getSchedulingPreference('U2')!,
      },
      responses,
      messages,
      notifications: this.environment.notifications,
      createdEvent,
      busy: {
        U1: [...this.busyByUser.U1],
        U2: [...this.busyByUser.U2],
      },
      log: this.log,
    };
  }

  private initialize() {
    const db = openDatabase(':memory:');
    migrate(db);
    const repository = new CafeRepository(db);
    repository.saveConfig({
      coffeeChannelId: 'LOCAL',
      firstPairingLocal: '2026-06-03T10:00',
      frequency: 'weekly',
      timezone: 'Europe/Berlin',
      reminderDelayDays: 3,
      maxParticipants: 200,
      matchCandidateAttempts: 200,
      maxRemindersPerMatch: 2,
    });
    const cycle = repository.createCycle('2026-06-03T08:00:00Z', 1);
    const match = repository.createMatch(cycle.id, 'U1', 'U2');
    for (const userId of USERS) connectParticipant(repository, this.config, userId);
    const calendar = new FakeCalendarService(repository, this.config);
    for (const userId of USERS) calendar.setBusy(userId, this.busyByUser[userId]);
    const environment = new MockSchedulingEnvironment();
    const coordinator = new SchedulingCoordinator(repository, this.config, calendar, createLogger('silent'), environment);
    return { db, repository, match, calendar, environment, coordinator };
  }

  private request(): SchedulingRequest | null {
    return this.repository.getSchedulingRequestByMatch(this.match.id);
  }

  private ensureRequest(): SchedulingRequest {
    return this.request() ?? this.coordinator.createRequestForMatch(this.match)!;
  }

  private selectedSlot(): SchedulingCandidateSlot | null {
    const request = this.request();
    return request?.selectedSlotId ? this.repository.getCandidateSlot(request.id, request.selectedSlotId) : null;
  }

  private syncBotMessages(): void {
    const request = this.request();
    if (!request) return;
    for (const message of this.repository.listSchedulingMessages(request.id)) {
      if (this.seenMessageIds.has(message.id)) continue;
      this.seenMessageIds.add(message.id);
      this.addLog(message.role === 'assistant' ? 'bot' : 'system', message.content);
    }
  }

  private addRequestSummary(): void {
    const request = this.request();
    if (!request) return;
    const selected = this.selectedSlot();
    if (request.status === 'proposed' && selected) this.addLog('bot', `Current proposal: ${formatSlot(selected)}.`);
    if (request.status === 'booked' && selected) this.addLog('bot', `Booked fake calendar event for ${formatSlot(selected)}.`);
    if (request.status === 'manual') this.addLog('bot', `Manual mode: ${request.error ?? 'participants arrange directly'}.`);
    if (request.status === 'failed') this.addLog('bot', `Failed: ${request.error ?? 'unknown error'}.`);
  }

  private async replanAfterCalendarChange(user: LocalUserId, text: string): Promise<void> {
    const request = this.request();
    if (!request || terminal(request.status)) return;
    await this.coordinator.handleParticipantResponse({ requestId: request.id, userId: user, response: 'alternatives', text }, '2026-06-01T09:04:00Z');
    this.syncBotMessages();
    this.addRequestSummary();
  }

  private addLog(who: LogEntry['who'], text: string): void {
    this.log.push({ at: new Date().toISOString(), who, text });
  }
}

function connectParticipant(repository: CafeRepository, config: RuntimeConfig, userId: LocalUserId): void {
  const now = '2026-06-01T08:00:00Z';
  const email = `${userId.toLowerCase()}@example.com`;
  repository.saveCalendarIdentity({ slackUserId: userId, provider: 'fake', calendarEmail: email, calendarId: `${userId}@calendar`, verifiedAt: now }, now);
  repository.saveVerifiedInviteAddress({ slackUserId: userId, email, source: 'manual', verifiedAt: now }, now);
  repository.saveSchedulingPreference(defaultSchedulingPreference(userId, config, now), now);
}

function asLocalUser(value: string): LocalUserId {
  if (value === 'U1' || value === 'U2') return value;
  throw new Error('Unknown local user');
}

function terminal(status: SchedulingRequest['status']): boolean {
  return status === 'booked' || status === 'manual' || status === 'failed' || status === 'expired';
}

function assertTime(value: string, field: string): void {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error(`${field} must use HH:mm`);
  const [hour, minute] = value.split(':').map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error(`${field} is out of range`);
}

function minutesOf(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatSlot(slot: SchedulingCandidateSlot): string {
  const starts = DateTime.fromISO(slot.startsAt, { zone: 'utc' }).setZone('Europe/Berlin');
  const ends = DateTime.fromISO(slot.endsAt, { zone: 'utc' }).setZone('Europe/Berlin');
  return `${starts.toFormat('ccc dd LLL HH:mm')}–${ends.toFormat('HH:mm')} Berlin`;
}

function formatBusyInterval(interval: BusyInterval): string {
  const starts = DateTime.fromISO(interval.startsAt, { zone: 'utc' }).setZone('Europe/Berlin');
  const ends = DateTime.fromISO(interval.endsAt, { zone: 'utc' }).setZone('Europe/Berlin');
  return `${starts.toFormat('ccc dd LLL HH:mm')}–${ends.toFormat('HH:mm')} Berlin`;
}

function sameInterval(left: BusyInterval, right: BusyInterval): boolean {
  return left.startsAt === right.startsAt && left.endsAt === right.endsAt;
}

function intervalFromLocalInput(input: Record<string, unknown>): BusyInterval {
  const date = stringOr(input.date, '');
  const time = stringOr(input.time, '');
  assertTime(time, 'busy time');
  const [hour, minute] = time.split(':').map(Number);
  if (minute !== 0 && minute !== 30) throw new Error('busy time must start on a 00 or 30 minute boundary');
  const starts = DateTime.fromISO(`${date}T${time}`, { zone: 'Europe/Berlin' });
  if (!starts.isValid) throw new Error('busy date must be YYYY-MM-DD');
  return {
    startsAt: starts.toUTC().toISO({ suppressMilliseconds: true })!,
    endsAt: starts.plus({ minutes: 30 }).toUTC().toISO({ suppressMilliseconds: true })!,
  };
}

function weekIntervals(weekStart: string, startTime: string, endTime: string): BusyInterval[] {
  assertTime(startTime, 'week start time');
  assertTime(endTime, 'week end time');
  const startMinute = minutesOf(startTime);
  const endMinute = minutesOf(endTime);
  if (startMinute >= endMinute) throw new Error('week end time must be later than start time');
  const startDay = DateTime.fromISO(weekStart, { zone: 'Europe/Berlin' }).startOf('day');
  if (!startDay.isValid) throw new Error('weekStart must be YYYY-MM-DD');
  const intervals: BusyInterval[] = [];
  for (let day = 0; day < 5; day += 1) {
    for (let minute = startMinute; minute + 30 <= endMinute; minute += 30) {
      const starts = startDay.plus({ days: day }).set({ hour: Math.floor(minute / 60), minute: minute % 60 });
      intervals.push({
        startsAt: starts.toUTC().toISO({ suppressMilliseconds: true })!,
        endsAt: starts.plus({ minutes: 30 }).toUTC().toISO({ suppressMilliseconds: true })!,
      });
    }
  }
  return intervals;
}

function shuffle<T>(items: T[]): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('Request body too large');
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function handleApi(harness: LocalSchedulingHarness, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, 200, harness.state());
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  const body = await readJson(req);
  if (pathname === '/api/reset') return sendJson(res, 200, harness.reset());
  if (pathname === '/api/propose') return sendJson(res, 200, await harness.propose());
  if (pathname === '/api/message') return sendJson(res, 200, await harness.sendMessage(String(body.userId ?? ''), String(body.text ?? '')));
  if (pathname === '/api/accept') {
    const slotIds = Array.isArray(body.slotIds) ? body.slotIds.map(String) : body.slotId == null ? [] : [String(body.slotId)];
    return sendJson(res, 200, await harness.accept(String(body.userId ?? ''), slotIds));
  }
  if (pathname === '/api/manual') return sendJson(res, 200, await harness.manual(String(body.userId ?? '')));
  if (pathname === '/api/preferences') return sendJson(res, 200, await harness.savePreferences(body));
  if (pathname === '/api/busy') return sendJson(res, 200, await harness.blockBusySlot(body));
  if (pathname === '/api/busy/remove') return sendJson(res, 200, await harness.removeBusySlot(body));
  if (pathname === '/api/busy/toggle') return sendJson(res, 200, await harness.toggleBusySlot(body));
  if (pathname === '/api/busy/shuffle') return sendJson(res, 200, await harness.shuffleBusySlots(body));
  if (pathname === '/api/busy/clear') return sendJson(res, 200, await harness.clearBusySlots(body));
  return sendJson(res, 404, { error: 'Not found' });
}

export function createLocalSchedulingServer(harness = new LocalSchedulingHarness()) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendHtml(res);
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(harness, url.pathname, req, res).catch((error) => {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  });
}

const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cafe local scheduling test</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f1eb; color: #27170f; }
    header { padding: 18px 22px; background: #6f4e37; color: white; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    header h1 { margin: 0; font-size: 20px; }
    button { border: 0; border-radius: 10px; padding: 9px 12px; background: #6f4e37; color: white; cursor: pointer; font-weight: 650; }
    button.secondary { background: #c8aa8a; color: #27170f; }
    button.danger { background: #9d2f2f; }
    button:disabled { opacity: .55; cursor: wait; }
    main { display: grid; grid-template-columns: minmax(560px, 700px) 1fr; gap: 16px; padding: 16px; }
    .users { display: grid; gap: 16px; }
    .card { background: white; border-radius: 16px; padding: 16px; box-shadow: 0 8px 22px rgba(39,23,15,.08); }
    .card h2, .card h3 { margin: 0 0 12px; }
    textarea, input { box-sizing: border-box; width: 100%; border: 1px solid #dbc7b8; border-radius: 10px; padding: 9px 10px; font: inherit; background: #fffaf5; color: inherit; }
    input[type="checkbox"] { width: auto; accent-color: #6f4e37; }
    textarea { min-height: 86px; resize: vertical; }
    label { display: block; font-size: 12px; font-weight: 700; color: #765640; margin: 10px 0 5px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .muted { color: #7c6759; font-size: 13px; }
    .status { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 8px; margin-bottom: 16px; }
    .pill { background: #fff7ef; border: 1px solid #ead7c7; border-radius: 12px; padding: 10px; min-height: 44px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .pill b { display: block; font-size: 11px; text-transform: uppercase; color: #8a6a53; }
    .calendar-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin: 14px 0 8px; }
    .calendar-toolbar input { width: 70px; padding: 7px 8px; }
    .week-grid { display: grid; grid-template-columns: 56px repeat(5, minmax(70px, 1fr)); gap: 4px; align-items: stretch; }
    .day-head, .time-cell { font-size: 11px; font-weight: 800; color: #765640; text-align: center; align-content: center; }
    .time-cell { text-align: right; padding-right: 4px; }
    button.slot { min-height: 28px; border-radius: 8px; padding: 3px 4px; background: #f8efe6; color: #7a604e; border: 1px solid #ead7c7; font-size: 12px; font-weight: 700; }
    button.slot:hover { background: #ead7c7; }
    button.slot.busy { background: #9d2f2f; color: white; border-color: #7f2424; }
    button.slot.proposed { outline: 3px solid #3f8cff; outline-offset: -2px; }
    button.slot.busy.proposed { outline-color: #ffd166; }
    .proposal-choice { width: 100%; text-align: left; background: #e8f3ff; color: #17385f; margin-top: 6px; border-radius: 10px; box-sizing: border-box; padding: 8px 10px; display: block; }
    #log { display: flex; flex-direction: column; gap: 8px; max-height: 430px; overflow: auto; padding-right: 4px; }
    .msg { border-radius: 14px; padding: 10px 12px; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; max-width: 100%; box-sizing: border-box; }
    .msg.bot { background: #e8f3ff; align-self: flex-start; }
    .msg.system { background: #f4eadf; align-self: center; font-size: 13px; }
    .msg.U1 { background: #e9f8e8; align-self: flex-end; }
    .msg.U2 { background: #fff1c7; align-self: flex-end; }
    pre { background: #2b211b; color: #fff7ef; border-radius: 14px; padding: 12px; overflow: auto; max-height: 360px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .error { color: #9d2f2f; font-weight: 700; }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } .status { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>☕ Local Scheduling Test UI</h1>
      <div class="muted" style="color:#f3dfcc">Одна страница: U1, U2, сообщения пользователей и вывод бота. Slack не используется.</div>
    </div>
    <div class="row">
      <button class="secondary" onclick="post('/api/reset')">Reset</button>
      <button onclick="post('/api/propose')">Bot propose</button>
    </div>
  </header>
  <main>
    <section class="users">
      <div id="user-U1"></div>
      <div id="user-U2"></div>
    </section>
    <section>
      <div class="status" id="status"></div>
      <div class="card">
        <h2>Bot output</h2>
        <div id="busy" class="muted"></div>
        <div id="error" class="error"></div>
        <div id="log"></div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>State</h3>
        <pre id="state"></pre>
      </div>
    </section>
  </main>
<script>
let state = null;
let busy = false;
let weekStart = '2026-06-01';
const calendarStartTime = '10:00';
const calendarEndTime = '17:00';

function slotText(slot) {
  if (!slot) return '—';
  const start = new Date(slot.startsAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' });
  const end = new Date(slot.endsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  return start + '–' + end + ' Berlin';
}

async function post(path, body = {}) {
  busy = true; render();
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json();
    if (!response.ok || json.error) throw new Error(json.error || response.statusText);
    state = json;
    document.getElementById('error').textContent = '';
  } catch (error) {
    document.getElementById('error').textContent = error.message || String(error);
  } finally {
    busy = false; render();
  }
}

async function load() {
  const response = await fetch('/api/state');
  state = await response.json();
  render();
}

function sendMessage(userId) {
  const input = document.getElementById(userId + '-text');
  const text = input.value;
  input.value = '';
  post('/api/message', { userId, text });
}

function savePrefs(userId) {
  post('/api/preferences', {
    userId,
    preferredStart: document.getElementById(userId + '-start').value,
    preferredEnd: document.getElementById(userId + '-end').value,
    durationMinutes: document.getElementById(userId + '-duration').value,
    searchHorizonDays: document.getElementById(userId + '-horizon').value,
    minNoticeHours: document.getElementById(userId + '-notice').value,
  });
}

function toggleBusy(userId, date, time) {
  post('/api/busy/toggle', { userId, date, time });
}

function shuffleBusy(userId) {
  post('/api/busy/shuffle', {
    userId,
    count: document.getElementById(userId + '-shuffle-count').value,
    weekStart,
    startTime: calendarStartTime,
    endTime: calendarEndTime,
  });
}

function clearBusy(userId) {
  post('/api/busy/clear', { userId });
}

function acceptSelected(userId) {
  const slotIds = [...document.querySelectorAll('input[name="' + userId + '-proposed"]:checked')].map((input) => input.value);
  post('/api/accept', { userId, slotIds });
}

function shiftWeek(days) {
  weekStart = addDays(weekStart, days);
  render();
}

function addDays(date, days) {
  const next = new Date(date + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function weekDays() {
  return [0, 1, 2, 3, 4].map(offset => addDays(weekStart, offset));
}

function timeSlots() {
  const slots = [];
  const start = minutes(calendarStartTime);
  const end = minutes(calendarEndTime);
  for (let value = start; value + 30 <= end; value += 30) slots.push(timeFromMinutes(value));
  return slots;
}

function minutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function timeFromMinutes(value) {
  const hour = String(Math.floor(value / 60)).padStart(2, '0');
  const minute = String(value % 60).padStart(2, '0');
  return hour + ':' + minute;
}

function localDateTimeParts(iso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: map.year + '-' + map.month + '-' + map.day, time: map.hour + ':' + map.minute };
}

function renderWeekCalendar(userId) {
  const days = weekDays();
  const times = timeSlots();
  const busyKeys = new Set((state?.busy?.[userId] || []).map(interval => {
    const local = localDateTimeParts(interval.startsAt);
    return local.date + '|' + local.time;
  }));
  const proposedKeys = new Set((state?.activeSlots || []).map(slot => {
    const local = localDateTimeParts(slot.startsAt);
    return local.date + '|' + local.time;
  }));
  if (state?.selectedSlot) {
    const local = localDateTimeParts(state.selectedSlot.startsAt);
    proposedKeys.add(local.date + '|' + local.time);
  }
  let grid = '<div class="week-grid"><div></div>' + days.map(day => '<div class="day-head">' + formatDay(day) + '</div>').join('');
  for (const time of times) {
    grid += '<div class="time-cell">' + time + '</div>';
    for (const day of days) {
      const key = day + '|' + time;
      const isBusy = busyKeys.has(key);
      const isProposed = proposedKeys.has(key);
      const classes = ['slot', isBusy ? 'busy' : '', isProposed ? 'proposed' : ''].filter(Boolean).join(' ');
      const label = isBusy ? '×' : isProposed ? '★' : '';
      grid += '<button class="' + classes + '" data-action="toggle-busy" data-user="' + userId + '" data-date="' + day + '" data-time="' + time + '" title="' + userId + ' ' + day + ' ' + time + '">' + label + '</button>';
    }
  }
  grid += '</div>';
  return '<div class="calendar-toolbar">' +
    '<strong>Busy week</strong>' +
    '<span class="muted">' + days[0] + ' — ' + days[4] + '</span>' +
    '<button class="secondary" data-action="week-prev">←</button>' +
    '<button class="secondary" data-action="week-next">→</button>' +
    '<span class="muted">Random close</span>' +
    '<input id="' + userId + '-shuffle-count" type="number" min="1" value="5">' +
    '<button class="secondary" data-action="shuffle-busy" data-user="' + userId + '">Shuffle N</button>' +
    '<button class="danger" data-action="clear-busy" data-user="' + userId + '">Clear</button>' +
    '</div>' + grid + '<div class="muted" style="margin-top:6px">Click a half-hour cell to toggle busy. × = busy, ★ = proposed option.</div>';
}

function formatDay(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
}

function renderProposalChoices(userId) {
  const proposed = state?.activeSlots || [];
  if (!proposed.length) return '<div class="muted">No proposed slots yet.</div>';
  return '<div class="muted">Select every option that works for you (1–3), then confirm.</div>' +
    proposed.map((slot, index) =>
      '<label class="proposal-choice"><input type="checkbox" name="' + userId + '-proposed" value="' + escapeAttr(slot.id) + '"> Option ' + (index + 1) + ': ' + escapeHtml(slotText(slot)) + '</label>'
    ).join('') +
    '<button class="proposal-choice" data-action="accept-selected" data-user="' + userId + '">Confirm selected slots</button>';
}

function renderUser(userId) {
  const pref = state?.preferences?.[userId] || {};
  document.getElementById('user-' + userId).innerHTML = '<div class="card">' +
    '<h2>' + userId + '</h2>' +
    '<div class="grid2">' +
      '<div><label>Preferred start</label><input id="' + userId + '-start" value="' + escapeAttr(pref.preferredStart || '10:00') + '"></div>' +
      '<div><label>Preferred end</label><input id="' + userId + '-end" value="' + escapeAttr(pref.preferredEnd || '17:00') + '"></div>' +
      '<div><label>Duration</label><input id="' + userId + '-duration" value="' + escapeAttr(pref.durationMinutes || 30) + '"></div>' +
      '<div><label>Horizon days</label><input id="' + userId + '-horizon" value="' + escapeAttr(pref.searchHorizonDays || 7) + '"></div>' +
    '</div>' +
    '<label>Minimum notice hours</label><input id="' + userId + '-notice" value="' + escapeAttr(pref.minNoticeHours ?? 24) + '">' +
    '<div class="row" style="margin-top:10px"><button class="secondary" data-action="save-prefs" data-user="' + userId + '">Save prefs + replan</button></div>' +
    renderWeekCalendar(userId) +
    '<label>Proposed slots</label>' + renderProposalChoices(userId) +
    '<label>Message to bot</label><textarea id="' + userId + '-text" placeholder="e.g. Wednesday after lunch, after 15, not Friday"></textarea>' +
    '<div class="row" style="margin-top:10px">' +
      '<button data-action="send-message" data-user="' + userId + '">Send instruction</button>' +
      '<button class="danger" data-action="manual" data-user="' + userId + '">Manual</button>' +
    '</div>' +
  '</div>';
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (button.dataset.action === 'week-prev') return shiftWeek(-7);
  if (button.dataset.action === 'week-next') return shiftWeek(7);
  const userId = button.dataset.user;
  if (button.dataset.action === 'save-prefs') savePrefs(userId);
  if (button.dataset.action === 'toggle-busy') toggleBusy(userId, button.dataset.date, button.dataset.time);
  if (button.dataset.action === 'shuffle-busy') shuffleBusy(userId);
  if (button.dataset.action === 'clear-busy') clearBusy(userId);
  if (button.dataset.action === 'send-message') sendMessage(userId);
  if (button.dataset.action === 'accept-selected') acceptSelected(userId);
  if (button.dataset.action === 'manual') post('/api/manual', { userId });
});

function render() {
  if (!state) return;
  document.getElementById('busy').textContent = busy ? 'Working... Pi calls can take a few seconds.' : '';
  renderUser('U1');
  renderUser('U2');
  document.querySelectorAll('button').forEach(button => button.disabled = busy);
  const request = state.request;
  document.getElementById('status').innerHTML = [
    ['Status', request?.status || 'none'],
    ['Booked slot', slotText(state.selectedSlot)],
    ['Proposed slots', (state.activeSlots || []).map((slot, index) => (index + 1) + '. ' + slotText(slot)).join('<br>') || 'none'],
    ['Fake event', state.createdEvent?.providerEventId || 'none'],
  ].map(([label, value]) => '<div class="pill"><b>' + label + '</b>' + value + '</div>').join('');
  document.getElementById('log').innerHTML = (state.log || []).map(item =>
    '<div class="msg ' + item.who + '"><b>' + item.who + '</b><br>' + escapeHtml(item.text) + '</div>'
  ).join('');
  document.getElementById('state').textContent = JSON.stringify({
    request: state.request,
    selectedSlot: state.selectedSlot,
    activeSlots: state.activeSlots,
    responses: state.responses,
    messages: state.messages,
    notifications: state.notifications,
    busy: state.busy,
    createdEvent: state.createdEvent,
  }, null, 2);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

load();
</script>
</body>
</html>`;

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = envInt('LOCAL_SCHEDULING_PORT', 8787);
  const server = createLocalSchedulingServer();
  server.listen(port, () => {
    console.log(`Local scheduling test UI: http://localhost:${port}`);
    console.log('Uses fake calendars and the real Pi scheduling agent from your .pi / env credentials.');
  });
}
