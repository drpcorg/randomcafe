import { describe, expect, it, vi } from 'vitest';
import { CafeRepository, migrate, openDatabase } from '../src/db.js';
import { FakeCalendarService } from '../src/calendar/fake.js';
import { DateTime } from 'luxon';
import { defaultSchedulingPreference, generateSharedSlots } from '../src/calendar/service.js';
import { createLogger } from '../src/logger.js';
import { SchedulingCoordinator } from '../src/scheduling.js';
import { SchedulingAgent } from '../src/schedulingAgent.js';
import { processSchedulingNotificationJobs } from '../src/slack/schedulingNotifications.js';
import { provisionCalendarIdentitiesForPendingScheduling } from '../src/slack/calendarProvisioning.js';
import { ACTION_SCHEDULE_ACCEPT, parseSchedulingActionValue, schedulingProposalBlocks } from '../src/slack/schedulingMessages.js';
import type { RuntimeConfig } from '../src/types.js';

const runtimeConfig: RuntimeConfig = {
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  adminUserIds: new Set(['UADMIN']),
  databasePath: ':memory:',
  logLevel: 'silent',
  schedulerIntervalSeconds: 60,
  schedulingPlanningConcurrency: 4,
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

function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  const repository = new CafeRepository(db);
  repository.saveConfig({
    coffeeChannelId: 'C0123456789',
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
  const calendar = new FakeCalendarService(repository, runtimeConfig);
  const coordinator = new SchedulingCoordinator(repository, runtimeConfig, calendar, createLogger('silent'));
  return { db, repository, match, calendar, coordinator };
}

function connect(repository: CafeRepository, userId: string) {
  const now = '2026-06-01T08:00:00Z';
  repository.saveCalendarIdentity({ slackUserId: userId, provider: 'fake', calendarEmail: `${userId.toLowerCase()}@example.com`, calendarId: `${userId}@calendar`, verifiedAt: now });
  repository.saveVerifiedInviteAddress({ slackUserId: userId, email: `${userId.toLowerCase()}@example.com`, source: 'calendar', verifiedAt: now });
  repository.saveSchedulingPreference(defaultSchedulingPreference(userId, runtimeConfig, now));
}

function localHour(iso: string): number {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone('Europe/Berlin').hour;
}

function localWeekday(iso: string): number {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone('Europe/Berlin').weekday;
}

function createProposedSlots(repository: CafeRepository, requestId: number, maxResults = 3) {
  const slots = generateSharedSlots({
    requestId,
    timezone: 'Europe/Berlin',
    now: '2026-06-01T08:00:00Z',
    participants: ['U1', 'U2'].map((slackUserId) => ({
      slackUserId,
      identity: repository.getCalendarIdentity(slackUserId),
      inviteAddress: repository.getVerifiedInviteAddress(slackUserId),
      preference: repository.getSchedulingPreference(slackUserId) ?? defaultSchedulingPreference(slackUserId, runtimeConfig),
    })),
    busyByUser: new Map(),
    maxResults,
  });
  const saved = repository.saveCandidateSlots(requestId, slots, '2026-06-01T08:00:00Z');
  repository.markSlotsInactiveExcept(requestId, saved.map((slot) => slot.id), '2026-06-01T08:00:00Z');
  repository.markSchedulingProposed(requestId, null, '2026-06-01T08:00:00Z');
  return saved;
}

describe('calendar slot search', () => {
  it('generates enough unfiltered candidate slots for the agent to interpret text preferences', () => {
    const slots = generateSharedSlots({
      requestId: 1,
      timezone: 'Europe/Berlin',
      now: '2026-06-01T08:00:00Z',
      participants: [
        { slackUserId: 'U1', identity: { slackUserId: 'U1', provider: 'fake', calendarEmail: 'u1@example.com', calendarId: 'u1', verifiedAt: '', createdAt: '', updatedAt: '' }, inviteAddress: null, preference: defaultSchedulingPreference('U1', runtimeConfig) },
      ],
      busyByUser: new Map(),
    });

    expect(slots.length).toBeGreaterThan(20);
    expect(slots.some((slot) => localWeekday(slot.startsAt) === 4)).toBe(true);
  });

  it('generates only slots outside opted-in busy intervals and preserves privacy reasons', () => {
    const slots = generateSharedSlots({
      requestId: 1,
      timezone: 'Europe/Berlin',
      now: '2026-06-01T08:00:00Z',
      participants: [
        { slackUserId: 'U1', identity: { slackUserId: 'U1', provider: 'fake', calendarEmail: 'u1@example.com', calendarId: 'u1', verifiedAt: '', createdAt: '', updatedAt: '' }, inviteAddress: null, preference: defaultSchedulingPreference('U1', runtimeConfig) },
      ],
      busyByUser: new Map([['U1', [{ startsAt: '2026-06-02T08:00:00Z', endsAt: '2026-06-02T09:00:00Z' }]]]),
      maxResults: 5,
    });

    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((slot) => slot.startsAt === '2026-06-02T08:00:00Z')).toBe(false);
    expect(slots[0]?.reasons.join(' ')).toContain('available');
  });

  it('respects structured preferred windows for all participants', () => {
    const latePreference = { ...defaultSchedulingPreference('U2', runtimeConfig), preferredStart: '14:00', preferredEnd: '16:00' };
    const slots = generateSharedSlots({
      requestId: 2,
      timezone: 'Europe/Berlin',
      now: '2026-06-01T08:00:00Z',
      participants: [
        { slackUserId: 'U1', identity: { slackUserId: 'U1', provider: 'fake', calendarEmail: 'u1@example.com', calendarId: 'u1', verifiedAt: '', createdAt: '', updatedAt: '' }, inviteAddress: null, preference: defaultSchedulingPreference('U1', runtimeConfig) },
        { slackUserId: 'U2', identity: { slackUserId: 'U2', provider: 'fake', calendarEmail: 'u2@example.com', calendarId: 'u2', verifiedAt: '', createdAt: '', updatedAt: '' }, inviteAddress: null, preference: latePreference },
      ],
      busyByUser: new Map(),
      maxResults: 5,
    });

    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => localHour(slot.startsAt) >= 14 && localHour(slot.endsAt) <= 16)).toBe(true);
  });

});

describe('scheduling repository and coordinator', () => {
  it('provisions pending scheduling identities from Slack profile email before planning', async () => {
    const { db, repository, match, coordinator } = setup();
    coordinator.createRequestForMatch(match);
    const client = {
      users: {
        info: vi.fn(async ({ user }: { user: string }) => ({ user: { id: user, profile: { email: `${user.toLowerCase()}@example.com` } } })),
      },
    };

    const provisioned = await provisionCalendarIdentitiesForPendingScheduling(client, repository, runtimeConfig, createLogger('silent'), '2026-06-01T08:00:00Z');

    expect(provisioned).toBe(2);
    expect(repository.getCalendarIdentity('U1')?.calendarId).toBe('u1@example.com');
    expect(repository.getVerifiedInviteAddress('U2')?.email).toBe('u2@example.com');
    expect(repository.getSchedulingPreference('U1')?.automatedSchedulingEnabled).toBe(true);
    db.close();
  });

  it('books exactly one event after both participants accept the same active slot', async () => {
    const { db, repository, match, coordinator } = setup();
    connect(repository, 'U1');
    connect(repository, 'U2');
    const request = coordinator.createRequestForMatch(match)!;
    const [slot] = createProposedSlots(repository, request.id, 1);
    expect(repository.getSchedulingRequest(request.id)?.status).toBe('proposed');

    await coordinator.handleParticipantResponse({ requestId: request.id, userId: 'U1', response: 'accepted', slotId: slot.id }, '2026-06-01T09:00:00Z');
    expect(repository.getSchedulingRequest(request.id)?.status).toBe('proposed');
    await coordinator.handleParticipantResponse({ requestId: request.id, userId: 'U2', response: 'accepted', slotId: slot.id }, '2026-06-01T09:01:00Z');

    const booked = repository.getSchedulingRequest(request.id)!;
    expect(booked.status).toBe('booked');
    expect(booked.providerEventId).toContain('fake_');
    expect(repository.listDueSchedulingNotificationJobs('2026-06-01T09:02:00Z').filter((job) => job.type === 'booked')).toHaveLength(2);
    db.close();
  });

  it('books when participants select overlapping acceptable slots', async () => {
    const { db, repository, match, coordinator } = setup();
    connect(repository, 'U1');
    connect(repository, 'U2');
    const request = coordinator.createRequestForMatch(match)!;
    const proposed = createProposedSlots(repository, request.id, 3);

    await coordinator.handleParticipantResponse({ requestId: request.id, userId: 'U1', response: 'accepted', slotIds: [proposed[0]!.id, proposed[1]!.id] }, '2026-06-01T09:00:00Z');
    expect(repository.getSchedulingRequest(request.id)?.status).toBe('proposed');
    await coordinator.handleParticipantResponse({ requestId: request.id, userId: 'U2', response: 'accepted', slotIds: [proposed[1]!.id, proposed[2]!.id] }, '2026-06-01T09:01:00Z');

    const booked = repository.getSchedulingRequest(request.id)!;
    expect(booked.status).toBe('booked');
    expect(booked.selectedSlotId).toBe(proposed[1]!.id);
    db.close();
  });

  it('switches to manual when no participant opted into automated scheduling', async () => {
    const { db, repository, match, coordinator } = setup();
    coordinator.createRequestForMatch(match);

    await coordinator.processPendingRequests('2026-06-01T08:00:00Z');

    const request = repository.getSchedulingRequestByMatch(match.id)!;
    expect(request.status).toBe('manual');
    expect(repository.listDueSchedulingNotificationJobs('2026-06-01T08:00:00Z')).toHaveLength(2);
    db.close();
  });

  it('rejects stale slot actions after replanning', async () => {
    const { db, repository, match, coordinator } = setup();
    connect(repository, 'U1');
    connect(repository, 'U2');
    const request = coordinator.createRequestForMatch(match)!;
    const [oldSlot] = createProposedSlots(repository, request.id, 1);
    repository.markSlotsInactiveExcept(request.id, []);

    await coordinator.handleParticipantResponse({ requestId: request.id, userId: 'U1', response: 'accepted', slotId: oldSlot.id }, '2026-06-01T09:00:00Z');

    expect(repository.listSchedulingResponses(request.id).filter((response) => response.response === 'accepted')).toHaveLength(0);
    expect(repository.getSchedulingRequest(request.id)?.status).toBe('proposed');
    db.close();
  });
});

describe('scheduling agent guardrails', () => {
  it('rejects unknown slot ids from agent-style recommendations', async () => {
    const { db, repository, match, coordinator } = setup();
    connect(repository, 'U1');
    connect(repository, 'U2');
    const request = coordinator.createRequestForMatch(match)!;
    createProposedSlots(repository, request.id, 1);
    const agent = new SchedulingAgent(repository, runtimeConfig);

    expect(() => agent.validateRecommendation({ slotIds: ['slot_private_title_leak'], message: 'bad' }, repository.listCandidateSlots(request.id, 'active'))).toThrow('active persisted slot');
    expect(JSON.stringify(repository.listCandidateSlots(request.id))).not.toContain('private_title');
    db.close();
  });

  it('rejects agent messages that do not mention proposed slots or claim booking happened', async () => {
    const { db, repository, match, coordinator } = setup();
    connect(repository, 'U1');
    connect(repository, 'U2');
    const request = coordinator.createRequestForMatch(match)!;
    const [slot] = createProposedSlots(repository, request.id, 1);
    const agent = new SchedulingAgent(repository, runtimeConfig);

    expect(() => agent.validateRecommendation({ slotIds: [slot.id], message: 'Looks good.' }, [slot])).toThrow('too short');
    expect(() => agent.validateRecommendation({ slotIds: [slot.id], message: `I booked your calendar event for ${slot.id}.` }, [slot])).toThrow('must not claim');
    expect(() => agent.validateRecommendation({ slotIds: [slot.id], message: 'This is a sufficiently long scheduling proposal without the actual slot.' }, [slot])).toThrow('does not mention');
    expect(agent.validateRecommendation({ slotIds: [slot.id], message: `Proposal ${slot.id}: ${slot.startsAt} to ${slot.endsAt}. Please confirm if this works.` }, [slot]).slotIds).toEqual([slot.id]);
    db.close();
  });
});

describe('scheduling Slack notifications', () => {
  it('sends proposal notifications with scheduling actions once', async () => {
    const { db, repository, match, coordinator } = setup();
    connect(repository, 'U1');
    connect(repository, 'U2');
    const request = coordinator.createRequestForMatch(match)!;
    createProposedSlots(repository, request.id, 3);
    repository.createSchedulingNotificationJob({ type: 'proposal', requestId: request.id, userId: 'U1', dedupeKey: `proposal:${request.id}:U1`, createdAt: '2026-06-01T08:00:00Z' });
    repository.createSchedulingNotificationJob({ type: 'proposal', requestId: request.id, userId: 'U2', dedupeKey: `proposal:${request.id}:U2`, createdAt: '2026-06-01T08:00:00Z' });

    const client = {
      conversations: { open: vi.fn(async ({ users }: { users: string }) => ({ channel: { id: `D${users}` } })) },
      chat: { postMessage: vi.fn(async () => ({ channel: 'D1', ts: '1.2' })) },
    };
    await processSchedulingNotificationJobs(client, repository, createLogger('silent'), '2026-06-01T08:00:00Z');
    await processSchedulingNotificationJobs(client, repository, createLogger('silent'), '2026-06-01T08:00:00Z');

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const proposed = repository.listCandidateSlots(request.id, 'active');
    const blocks = schedulingProposalBlocks(request, proposed);
    const choices = (blocks[1] as any).element;
    const actions = (blocks[2] as any).elements;
    const confirm = actions.find((item: any) => item.action_id === ACTION_SCHEDULE_ACCEPT);
    expect(choices.options).toHaveLength(Math.min(3, proposed.length));
    expect(parseSchedulingActionValue(choices.options[0].value)).toEqual({ requestId: request.id, slotId: proposed[0]!.id });
    expect(parseSchedulingActionValue(confirm.value)).toEqual({ requestId: request.id, slotId: null });
    db.close();
  });
});
