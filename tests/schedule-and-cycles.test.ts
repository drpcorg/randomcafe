import { describe, expect, it } from 'vitest';
import { CafeRepository, migrate, openDatabase } from '../src/db.js';
import { processDueCycles } from '../src/cycles.js';
import { dueScheduledTimes, scheduledAtForSequence, validateScheduleInput } from '../src/schedule.js';
import { createLogger } from '../src/logger.js';

function makeRepository() {
  const db = openDatabase(':memory:');
  migrate(db);
  return { db, repository: new CafeRepository(db) };
}

function mockSlackClient(memberIds: string[]) {
  return {
    conversations: {
      members: async () => ({ members: memberIds, response_metadata: {} }),
      info: async () => ({ ok: true }),
      open: async ({ users }: { users: string }) => ({ channel: { id: `D${users}` } }),
    },
    users: {
      info: async ({ user }: { user: string }) => ({ user: { id: user, name: user, real_name: user, is_bot: false, deleted: false } }),
    },
    chat: {
      postMessage: async () => ({ channel: 'D1', ts: '123.456' }),
    },
  };
}

describe('schedule validation', () => {
  it('rejects first pairing timestamps with UTC offsets', () => {
    const errors = validateScheduleInput({
      coffeeChannelId: 'C0123456789',
      firstPairingLocal: '2026-06-03T10:00:00Z',
      frequency: 'weekly',
      timezone: 'Europe/Berlin',
      reminderDelayDays: 3,
    });

    expect(errors.join('\n')).toContain('without UTC offset');
  });

  it('calculates recurring scheduled timestamps in the configured timezone', () => {
    const first = scheduledAtForSequence({ firstPairingLocal: '2026-06-03T10:00', timezone: 'Europe/Berlin', frequency: 'weekly' }, 1);
    const second = scheduledAtForSequence({ firstPairingLocal: '2026-06-03T10:00', timezone: 'Europe/Berlin', frequency: 'weekly' }, 2);

    expect(first).toBe('2026-06-03T08:00:00Z');
    expect(second).toBe('2026-06-10T08:00:00Z');
  });

  it('returns only due cycle timestamps after the last sequence', () => {
    const due = dueScheduledTimes(
      { firstPairingLocal: '2026-06-03T10:00', timezone: 'Europe/Berlin', frequency: 'weekly' },
      0,
      '2026-06-10T08:00:00Z',
    );

    expect(due).toEqual([
      { sequence: 1, scheduledAt: '2026-06-03T08:00:00Z' },
      { sequence: 2, scheduledAt: '2026-06-10T08:00:00Z' },
    ]);
  });
});

describe('cycle processing', () => {
  it('creates a due cycle exactly once for a scheduled timestamp', async () => {
    const { db, repository } = makeRepository();
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

    const client = mockSlackClient(['U1', 'U2']);
    const logger = createLogger('silent');

    const first = await processDueCycles(client, repository, logger, '2026-06-03T08:00:00Z');
    const second = await processDueCycles(client, repository, logger, '2026-06-03T08:00:00Z');

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(repository.listMatchesForCycle(repository.getLastCycle()!.id)).toHaveLength(1);
    db.close();
  });

  it('anchors due cycles from the last actual cycle after the admin changes the schedule start', async () => {
    const { db, repository } = makeRepository();
    repository.saveConfig({
      coffeeChannelId: 'C0123456789',
      firstPairingLocal: '2026-05-29T12:17',
      frequency: 'weekly',
      timezone: 'Europe/Berlin',
      reminderDelayDays: 3,
      maxParticipants: 200,
      matchCandidateAttempts: 200,
      maxRemindersPerMatch: 2,
    });

    const client = mockSlackClient(['U1', 'U2']);
    const logger = createLogger('silent');

    await processDueCycles(client, repository, logger, '2026-05-29T10:17:00Z');
    repository.saveConfig({
      coffeeChannelId: 'C0123456789',
      firstPairingLocal: '2026-06-03T18:10',
      frequency: 'weekly',
      timezone: 'Europe/Paris',
      reminderDelayDays: 3,
      maxParticipants: 200,
      matchCandidateAttempts: 200,
      maxRemindersPerMatch: 2,
    });

    const earlyResult = await processDueCycles(client, repository, logger, '2026-06-03T16:10:00Z');
    const result = await processDueCycles(client, repository, logger, '2026-06-05T10:17:00Z');
    const latestCycle = repository.getLastCycle()!;

    expect(earlyResult.created).toBe(0);
    expect(result.created).toBe(1);
    expect(latestCycle.sequence).toBe(2);
    expect(latestCycle.scheduledAt).toBe('2026-06-05T10:17:00Z');
    db.close();
  });

  it('expires active matches from the prior cycle when a new cycle starts', async () => {
    const { db, repository } = makeRepository();
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

    const client = mockSlackClient(['U1', 'U2']);
    const logger = createLogger('silent');

    await processDueCycles(client, repository, logger, '2026-06-03T08:00:00Z');
    const firstCycle = repository.getLastCycle()!;
    const firstMatch = repository.listMatchesForCycle(firstCycle.id)[0]!;
    await processDueCycles(client, repository, logger, '2026-06-10T08:00:00Z');
    const secondCycle = repository.getLastCycle()!;

    expect(repository.getMatch(firstMatch.id)!.outcome).toBe('expired');
    expect(secondCycle.scheduledAt).toBe('2026-06-10T08:00:00Z');
    expect(repository.getCycleByScheduledAt('2026-06-10T08:00:00.000Z')!.id).toBe(secondCycle.id);
    db.close();
  });
});
