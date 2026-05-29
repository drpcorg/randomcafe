import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { DateTime } from 'luxon';
import { FakeCalendarService } from '../src/calendar/fake.js';
import { defaultSchedulingPreference } from '../src/calendar/service.js';
import { CafeRepository, migrate, openDatabase, type SqliteDatabase } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { MockSchedulingEnvironment, SchedulingCoordinator } from '../src/scheduling.js';
import type { MatchRecord, RuntimeConfig, SchedulingCandidateSlot, SchedulingNotificationType, SchedulingPreference, SchedulingStatus } from '../src/types.js';

describe('scheduling module flow in a mock host environment', () => {
  let flow: SchedulingFlow;

  beforeEach(() => {
    flow = createSchedulingFlow();
  });

  afterEach(() => {
    flow.close();
  });

  it('bot proposes the only slot that fits participants calendars and preferences', async () => {
    await flow.run(
      given(participants('U1', 'U2').connected({
        searchHorizonDays: 2,
        preferredStart: '14:00',
        preferredEnd: '14:30',
      })),
      when(bot.proposes()),
      then(
        request.is('proposed'),
        slots.active.count(1),
        slots.active.allInBerlin({ date: '2026-06-02', startHour: 14, startMinute: 0 }),
        host.sent('proposal', 2),
        proposal.text.looksReal(),
      ),
    );
  });

  it('participant says “Wednesday after lunch” and the next proposal lands in that range', async () => {
    await flow.run(
      given(participants('U1', 'U2').connected()),
      when(bot.proposes()),
      capture.requestId('originalRequest'),
      capture.hostCount('proposal', 'originalProposalCount'),
      when(user('U2').says('в среду после обеда')),
      then(
        request.is('proposed'),
        request.sameAs('originalRequest'),
        response.textWasSaved('в среду после обеда'),
        slots.active.count(3),
        slots.active.allInBerlin({ weekday: 3, minHour: 13 }),
        host.sentPlus('proposal', 'originalProposalCount', 2),
      ),
    );
  });

  it('both participants give scheduling instructions and the next proposal satisfies both', async () => {
    await flow.run(
      given(participants('U1', 'U2').connected()),
      when(bot.proposes()),
      capture.requestId('originalRequest'),
      capture.hostCount('proposal', 'originalProposalCount'),
      when(
        user('U1').says('Wednesday'),
        user('U2').says('after 15'),
      ),
      then(
        request.is('proposed'),
        request.sameAs('originalRequest'),
        response.textWasSaved('Wednesday'),
        response.textWasSaved('after 15'),
        slots.active.count(3),
        slots.active.allInBerlin({ weekday: 3, minHour: 15 }),
        host.sentPlus('proposal', 'originalProposalCount', 4),
      ),
    );
  });

  it('participants choose different proposed slots and the bot suggests a fresh set', async () => {
    await flow.run(
      given(participants('U1', 'U2').connected()),
      when(bot.proposes()),
      capture.activeSlotIds('firstOptions'),
      capture.hostCount('proposal', 'originalProposalCount'),
      when(
        user('U1').accepts(proposedSlot(0)),
        user('U2').accepts(proposedSlot(1)),
      ),
      then(
        request.is('proposed'),
        slots.active.count(3),
        slots.active.noneOf('firstOptions'),
        calendarEvent.notCreated(),
        host.sentPlus('proposal', 'originalProposalCount', 2),
      ),
    );
  });

  it('both participants accept the proposed slot and the module books that exact slot', async () => {
    await flow.run(
      given(participants('U1', 'U2').connected({
        searchHorizonDays: 2,
        preferredStart: '14:00',
        preferredEnd: '14:30',
      })),
      when(bot.proposes()),
      capture.proposedSlot('proposedSlot'),
      when(users('U1', 'U2').accept(capturedSlot('proposedSlot'))),
      then(
        calendarEvent.bookedFor(capturedSlot('proposedSlot')),
        host.sent('booked', 2),
      ),
    );
  });

  it('one participant chooses manual mode and no calendar event is created', async () => {
    await flow.run(
      given(participants('U1', 'U2').connected()),
      when(bot.proposes()),
      when(user('U1').choosesManual()),
      then(
        request.is('manual'),
        calendarEvent.notCreated(),
        host.sent('manual', 2),
      ),
    );
  });
});

const baseSchedulingConfig: RuntimeConfig = {
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  adminUserIds: new Set(['UADMIN']),
  databasePath: ':memory:',
  logLevel: 'silent',
  schedulerIntervalSeconds: 60,
  maxParticipants: 200,
  matchCandidateAttempts: 200,
  maxRemindersPerMatch: 2,
  calendarSchedulingEnabled: true,
  calendarProvider: 'fake',
  calendarDefaultDurationMinutes: 30,
  calendarSearchHorizonDays: 7,
  calendarMinimumNoticeHours: 24,
  calendarDefaultPreferredStart: '10:00',
  calendarDefaultPreferredEnd: '17:00',
  calendarAgentFallbackMode: 'manual',
  piProvider: 'deepseek',
  piModel: 'deepseek-v4-flash',
  piAgentTimeoutMs: 60_000,
};

type FlowStep = (flow: SchedulingFlow) => void | Promise<void>;
type SlotRef = { resolve(flow: SchedulingFlow): SchedulingCandidateSlot };
type BerlinSlotExpectation = { weekday?: number; date?: string; startHour?: number; startMinute?: number; minHour?: number; maxHour?: number };

class SchedulingFlow {
  readonly runtimeConfig: RuntimeConfig;
  readonly db: SqliteDatabase;
  readonly repository: CafeRepository;
  readonly match: MatchRecord;
  readonly calendar: FakeCalendarService;
  readonly environment: MockSchedulingEnvironment;
  readonly coordinator: SchedulingCoordinator;
  private readonly memory = new Map<string, unknown>();

  constructor(config: Partial<RuntimeConfig> = {}) {
    this.runtimeConfig = { ...baseSchedulingConfig, ...config };
    this.db = openDatabase(':memory:');
    migrate(this.db);
    this.repository = new CafeRepository(this.db);
    this.repository.saveConfig({
      coffeeChannelId: 'C0123456789',
      firstPairingLocal: '2026-06-03T10:00',
      frequency: 'weekly',
      timezone: 'Europe/Berlin',
      reminderDelayDays: 3,
      maxParticipants: 200,
      matchCandidateAttempts: 200,
      maxRemindersPerMatch: 2,
    });
    const cycle = this.repository.createCycle('2026-06-03T08:00:00Z', 1);
    this.match = this.repository.createMatch(cycle.id, 'U1', 'U2');
    this.calendar = new FakeCalendarService(this.repository, this.runtimeConfig);
    this.environment = new MockSchedulingEnvironment();
    this.coordinator = new SchedulingCoordinator(this.repository, this.runtimeConfig, this.calendar, createLogger('silent'), this.environment);
  }

  async run(...steps: FlowStep[]): Promise<this> {
    for (const step of steps) await step(this);
    return this;
  }

  close(): void { this.db.close(); }
  remember<T>(key: string, value: T): void { this.memory.set(key, value); }
  recall<T>(key: string): T {
    if (!this.memory.has(key)) throw new Error(`No captured value named ${key}`);
    return this.memory.get(key) as T;
  }
  request() { return this.repository.getSchedulingRequestByMatch(this.match.id)!; }
  selectedSlot(): SchedulingCandidateSlot { return this.repository.getCandidateSlot(this.request().id, this.request().selectedSlotId!)!; }
  activeSlots(): SchedulingCandidateSlot[] { return this.repository.listCandidateSlots(this.request().id, 'active'); }
  agentText(): string { return this.repository.listSchedulingMessages(this.request().id).map((message) => message.content).join('\n'); }
}

function createSchedulingFlow(config: Partial<RuntimeConfig> = {}): SchedulingFlow { return new SchedulingFlow(config); }
function given(...steps: FlowStep[]): FlowStep { return async (flow) => { for (const step of steps) await step(flow); }; }
function when(...steps: FlowStep[]): FlowStep { return given(...steps); }
function then(...steps: FlowStep[]): FlowStep { return given(...steps); }

function participants(...userIds: string[]) {
  return {
    connected(preferences: Partial<SchedulingPreference> = {}): FlowStep {
      return (flow) => { for (const userId of userIds) connectParticipant(flow, userId, preferences); };
    },
  };
}

function user(userId: string) {
  return {
    says(text: string): FlowStep {
      return async (flow) => { await flow.coordinator.handleParticipantResponse({ requestId: flow.request().id, userId, response: 'text_preference', text }, '2026-06-01T09:00:00Z'); };
    },
    accepts(slot: SlotRef): FlowStep {
      return async (flow) => { await flow.coordinator.handleParticipantResponse({ requestId: flow.request().id, userId, response: 'accepted', slotId: slot.resolve(flow).id }, '2026-06-01T09:00:00Z'); };
    },
    choosesManual(): FlowStep {
      return async (flow) => { await flow.coordinator.handleParticipantResponse({ requestId: flow.request().id, userId, response: 'manual' }, '2026-06-01T09:00:00Z'); };
    },
  };
}

function users(...userIds: string[]) {
  return {
    accept(slot: SlotRef): FlowStep {
      return async (flow) => {
        let minute = 0;
        for (const userId of userIds) {
          await flow.coordinator.handleParticipantResponse({ requestId: flow.request().id, userId, response: 'accepted', slotId: slot.resolve(flow).id }, `2026-06-01T09:0${minute}:00Z`);
          minute += 1;
        }
      };
    },
  };
}

const bot = {
  proposes(): FlowStep {
    return async (flow) => {
      if (!flow.repository.getSchedulingRequestByMatch(flow.match.id)) flow.coordinator.createRequestForMatch(flow.match);
      await flow.coordinator.processPendingRequests('2026-06-01T08:00:00Z');
    };
  },
};

const capture = {
  requestId(key: string): FlowStep { return (flow) => flow.remember(key, flow.request().id); },
  proposedSlot(key: string): FlowStep { return (flow) => flow.remember(key, flow.activeSlots()[0]); },
  activeSlotIds(key: string): FlowStep { return (flow) => flow.remember(key, flow.activeSlots().map((slot) => slot.id)); },
  hostCount(type: SchedulingNotificationType, key: string): FlowStep { return (flow) => flow.remember(key, flow.environment.byType(type).length); },
};

function capturedSlot(key: string): SlotRef { return { resolve: (flow) => flow.recall<SchedulingCandidateSlot>(key) }; }
function proposedSlot(index: number): SlotRef { return { resolve: (flow) => flow.activeSlots()[index]! }; }

const request = {
  is(status: SchedulingStatus): FlowStep { return (flow) => assert.equal(flow.request().status, status); },
  sameAs(key: string): FlowStep { return (flow) => assert.equal(flow.request().id, flow.recall<number>(key)); },
};

const slots = {
  active: {
    count(expected: number): FlowStep { return (flow) => assert.equal(flow.activeSlots().length, expected); },
    someInBerlin(expected: BerlinSlotExpectation): FlowStep {
      return (flow) => {
        assert.ok(flow.activeSlots().some((slot) => slotMatchesInBerlin(slot, expected)), `expected at least one active slot matching ${JSON.stringify(expected)}`);
      };
    },
    allInBerlin(expected: BerlinSlotExpectation): FlowStep {
      return (flow) => {
        assert.ok(flow.activeSlots().length > 0, 'expected active slots');
        for (const slot of flow.activeSlots()) expectSlotInBerlin(slot, expected);
      };
    },
    noneOf(capturedSlotIdsKey: string): FlowStep {
      return (flow) => {
        const oldIds = new Set(flow.recall<string[]>(capturedSlotIdsKey));
        assert.ok(flow.activeSlots().every((slot) => !oldIds.has(slot.id)), 'expected fresh proposed slots');
      };
    },
  },
};

const proposal = {
  selectedSlot: {
    isOnlyActiveSlot(): FlowStep { return (flow) => assert.equal(flow.selectedSlot().id, flow.activeSlots()[0]?.id); },
    inBerlin(expected: BerlinSlotExpectation): FlowStep { return (flow) => expectSlotInBerlin(flow.selectedSlot(), expected); },
  },
  text: {
    looksReal(): FlowStep {
      return (flow) => {
        assert.ok(!flow.agentText().includes('Pi scheduling agent unavailable'));
        assert.doesNotMatch(flow.agentText(), /booked|created event|calendar event created/i);
        assert.match(flow.agentText(), /\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}/);
      };
    },
  },
};

const host = {
  sent(type: SchedulingNotificationType, count: number): FlowStep { return (flow) => assert.equal(flow.environment.byType(type).length, count); },
  sentPlus(type: SchedulingNotificationType, capturedCountKey: string, plus: number): FlowStep {
    return (flow) => assert.equal(flow.environment.byType(type).length, flow.recall<number>(capturedCountKey) + plus);
  },
};

const response = {
  textWasSaved(text: string): FlowStep {
    return (flow) => assert.ok(flow.repository.listSchedulingResponses(flow.request().id).some((item) => item.text === text));
  },
};

const calendarEvent = {
  bookedFor(slot: SlotRef): FlowStep {
    return (flow) => {
      const resolved = slot.resolve(flow);
      assert.equal(flow.request().status, 'booked');
      assert.equal(flow.request().selectedSlotId, resolved.id);
      assert.equal(flow.request().providerEventId, `fake_${flow.request().id}_${resolved.id}`);
      assert.equal(flow.calendar.getCreatedEvent(`${flow.request().id}:${resolved.id}`)?.providerEventId, flow.request().providerEventId);
    };
  },
  notCreated(): FlowStep { return (flow) => assert.equal(flow.request().providerEventId, null); },
};

function connectParticipant(flow: SchedulingFlow, userId: string, preferenceOverrides: Partial<SchedulingPreference>): void {
  const now = '2026-06-01T08:00:00Z';
  flow.repository.saveCalendarIdentity({ slackUserId: userId, provider: 'fake', calendarEmail: `${userId.toLowerCase()}@example.com`, calendarId: `${userId}@calendar`, verifiedAt: now });
  flow.repository.saveVerifiedInviteAddress({ slackUserId: userId, email: `${userId.toLowerCase()}@example.com`, source: 'calendar', verifiedAt: now });
  flow.repository.saveSchedulingPreference({ ...defaultSchedulingPreference(userId, flow.runtimeConfig, now), ...preferenceOverrides, slackUserId: userId, updatedAt: now });
}

function berlin(iso: string): DateTime { return DateTime.fromISO(iso, { zone: 'utc' }).setZone('Europe/Berlin'); }

function slotMatchesInBerlin(slot: SchedulingCandidateSlot, expected: BerlinSlotExpectation): boolean {
  const starts = berlin(slot.startsAt);
  const ends = berlin(slot.endsAt);
  if (expected.weekday != null && starts.weekday !== expected.weekday) return false;
  if (expected.date && starts.toFormat('yyyy-MM-dd') !== expected.date) return false;
  if (expected.startHour != null && starts.hour !== expected.startHour) return false;
  if (expected.startMinute != null && starts.minute !== expected.startMinute) return false;
  if (expected.minHour != null && starts.hour < expected.minHour) return false;
  if (expected.maxHour != null && ends.hour > expected.maxHour) return false;
  return true;
}

function expectSlotInBerlin(slot: SchedulingCandidateSlot, expected: BerlinSlotExpectation): void {
  const starts = berlin(slot.startsAt);
  const ends = berlin(slot.endsAt);
  if (expected.weekday != null) assert.equal(starts.weekday, expected.weekday);
  if (expected.date) assert.equal(starts.toFormat('yyyy-MM-dd'), expected.date);
  if (expected.startHour != null) assert.equal(starts.hour, expected.startHour);
  if (expected.startMinute != null) assert.equal(starts.minute, expected.startMinute);
  if (expected.minHour != null) assert.ok(starts.hour >= expected.minHour, `expected start hour ${starts.hour} >= ${expected.minHour}`);
  if (expected.maxHour != null) assert.ok(ends.hour <= expected.maxHour, `expected end hour ${ends.hour} <= ${expected.maxHour}`);
}
