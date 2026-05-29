import crypto from 'node:crypto';
import { DateTime, Interval } from 'luxon';
import type { Logger } from 'pino';
import type { CafeRepository } from '../db.js';
import type { CalendarIdentity, RuntimeConfig, SchedulingCandidateSlot, SchedulingPreference, VerifiedInviteAddress } from '../types.js';

export interface BusyInterval {
  startsAt: string;
  endsAt: string;
}

export interface SchedulingParticipantProfile {
  slackUserId: string;
  identity: CalendarIdentity | null;
  inviteAddress: VerifiedInviteAddress | null;
  preference: SchedulingPreference;
}

export interface FindCalendarBusyInput {
  participants: SchedulingParticipantProfile[];
  timezone: string;
  now?: string;
  horizonDays?: number;
}

export interface FindCalendarSlotsInput extends FindCalendarBusyInput {
  requestId: number;
  rejectedSlotIds?: Set<string>;
}

export interface RevalidateSlotInput {
  requestId: number;
  slot: SchedulingCandidateSlot;
  participants: SchedulingParticipantProfile[];
}

export interface CreateCalendarEventInput {
  requestId: number;
  slot: SchedulingCandidateSlot;
  participants: SchedulingParticipantProfile[];
  summary: string;
  description?: string;
}

export interface CreatedCalendarEvent {
  providerEventId: string;
  providerEventUrl?: string | null;
}

export interface CalendarService {
  resolveAvailabilityIdentity(slackUserId: string): Promise<CalendarIdentity | null>;
  resolveInviteAddress(slackUserId: string): Promise<VerifiedInviteAddress | null>;
  findSharedSlots(input: FindCalendarSlotsInput): Promise<Array<Omit<SchedulingCandidateSlot, 'requestId' | 'createdAt' | 'status'>>>;
  findBusyIntervals(input: FindCalendarBusyInput): Promise<Map<string, BusyInterval[]>>;
  revalidateSlot(input: RevalidateSlotInput): Promise<boolean>;
  createBotOwnedEvent(input: CreateCalendarEventInput): Promise<CreatedCalendarEvent>;
}

export function defaultSchedulingPreference(slackUserId: string, config: RuntimeConfig, updatedAt = new Date().toISOString()): SchedulingPreference {
  return {
    slackUserId,
    durationMinutes: config.calendarDefaultDurationMinutes,
    searchHorizonDays: config.calendarSearchHorizonDays,
    minNoticeHours: config.calendarMinimumNoticeHours,
    preferredStart: config.calendarDefaultPreferredStart,
    preferredEnd: config.calendarDefaultPreferredEnd,
    preferredWeekdays: [1, 2, 3, 4, 5],
    automatedSchedulingEnabled: true,
    updatedAt,
  };
}

export function slotIdFor(requestId: number, startsAt: string, endsAt: string): string {
  const hash = crypto.createHash('sha256').update(`${requestId}:${startsAt}:${endsAt}`).digest('hex').slice(0, 16);
  return `slot_${hash}`;
}

function parseTime(value: string): { hour: number; minute: number } {
  const [hourRaw, minuteRaw] = value.split(':');
  return { hour: Number(hourRaw ?? 0), minute: Number(minuteRaw ?? 0) };
}

function minutesOf(time: { hour: number; minute: number }): number {
  return time.hour * 60 + time.minute;
}

function overlapsBusy(startsAt: DateTime, endsAt: DateTime, busy: BusyInterval[]): boolean {
  const candidate = Interval.fromDateTimes(startsAt, endsAt);
  return busy.some((item) => {
    const interval = Interval.fromDateTimes(DateTime.fromISO(item.startsAt, { zone: 'utc' }), DateTime.fromISO(item.endsAt, { zone: 'utc' }));
    return candidate.overlaps(interval);
  });
}

export interface SlotSearchInput extends FindCalendarSlotsInput {
  busyByUser: Map<string, BusyInterval[]>;
  maxResults?: number;
}

export function generateSharedSlots(input: SlotSearchInput): Array<Omit<SchedulingCandidateSlot, 'requestId' | 'createdAt' | 'status'>> {
  const now = DateTime.fromISO(input.now ?? new Date().toISOString(), { zone: 'utc' });
  const preferences = input.participants.map((participant) => participant.preference);
  const durationMinutes = Math.max(...preferences.map((pref) => pref.durationMinutes));
  const searchHorizonDays = Math.max(...preferences.map((pref) => pref.searchHorizonDays));
  const minNoticeHours = Math.max(...preferences.map((pref) => pref.minNoticeHours));
  const preferredStart = preferences.map((pref) => parseTime(pref.preferredStart)).sort((a, b) => minutesOf(a) - minutesOf(b)).at(-1)!;
  const preferredEnd = preferences.map((pref) => parseTime(pref.preferredEnd)).sort((a, b) => minutesOf(a) - minutesOf(b))[0]!;
  const preferredWeekdays = preferences
    .map((pref) => new Set((pref.preferredWeekdays.length > 0 ? pref.preferredWeekdays : [1, 2, 3, 4, 5]).filter((day) => day >= 1 && day <= 7)))
    .reduce((intersection, current) => new Set([...intersection].filter((day) => current.has(day))));
  if (preferredWeekdays.size === 0) return [];
  const earliest = now.plus({ hours: minNoticeHours });
  const slots: Array<Omit<SchedulingCandidateSlot, 'requestId' | 'createdAt' | 'status'>> = [];
  const maxResults = input.maxResults ?? 80;

  for (let dayOffset = 0; dayOffset < searchHorizonDays && slots.length < maxResults * 4; dayOffset += 1) {
    const day = now.setZone(input.timezone).startOf('day').plus({ days: dayOffset });
    if (!preferredWeekdays.has(day.weekday)) continue;

    let cursor = day.set({ hour: preferredStart.hour, minute: preferredStart.minute, second: 0, millisecond: 0 });
    const windowEnd = day.set({ hour: preferredEnd.hour, minute: preferredEnd.minute, second: 0, millisecond: 0 });
    while (cursor.plus({ minutes: durationMinutes }) <= windowEnd) {
      const starts = cursor.toUTC();
      const ends = cursor.plus({ minutes: durationMinutes }).toUTC();
      cursor = cursor.plus({ minutes: 30 });
      if (starts < earliest) continue;
      const rejected = input.rejectedSlotIds?.has(slotIdFor(input.requestId, starts.toISO({ suppressMilliseconds: true })!, ends.toISO({ suppressMilliseconds: true })!));
      if (rejected) continue;

      let busy = false;
      for (const participant of input.participants) {
        if (!participant.identity || !participant.preference.automatedSchedulingEnabled) continue;
        if (overlapsBusy(starts, ends, input.busyByUser.get(participant.slackUserId) ?? [])) {
          busy = true;
          break;
        }
      }
      if (busy) continue;

      const startsIso = starts.toISO({ suppressMilliseconds: true })!;
      const endsIso = ends.toISO({ suppressMilliseconds: true })!;
      const score = dayOffset * 10 + Math.abs(cursor.hour - 11);
      const reasons = ['available for opted-in calendars', `${durationMinutes} minutes`, `within ${input.timezone} preferred window`];
      if (input.participants.some((participant) => !participant.identity || !participant.preference.automatedSchedulingEnabled)) reasons.push('one participant calendar not checked');
      slots.push({ id: slotIdFor(input.requestId, startsIso, endsIso), startsAt: startsIso, endsAt: endsIso, score, reasons });
    }
  }

  return slots.sort((left, right) => left.score - right.score || left.startsAt.localeCompare(right.startsAt)).slice(0, maxResults);
}

export abstract class RepositoryBackedCalendarService implements CalendarService {
  protected constructor(protected readonly repository: CafeRepository, protected readonly config: RuntimeConfig, protected readonly logger?: Logger) {}

  async resolveAvailabilityIdentity(slackUserId: string): Promise<CalendarIdentity | null> {
    return this.repository.getCalendarIdentity(slackUserId);
  }

  async resolveInviteAddress(slackUserId: string): Promise<VerifiedInviteAddress | null> {
    return this.repository.getVerifiedInviteAddress(slackUserId);
  }

  abstract findSharedSlots(input: FindCalendarSlotsInput): Promise<Array<Omit<SchedulingCandidateSlot, 'requestId' | 'createdAt' | 'status'>>>;
  abstract findBusyIntervals(input: FindCalendarBusyInput): Promise<Map<string, BusyInterval[]>>;
  abstract revalidateSlot(input: RevalidateSlotInput): Promise<boolean>;
  abstract createBotOwnedEvent(input: CreateCalendarEventInput): Promise<CreatedCalendarEvent>;
}
