import { describe, expect, it, vi } from 'vitest';
import { CafeRepository, migrate, openDatabase } from '../src/db.js';
import { recordFeedbackAndUpdateMatch } from '../src/feedback.js';
import { processNotificationJobs, retryDelayMs } from '../src/slack/notifications.js';
import { createLogger } from '../src/logger.js';

function setupRepository() {
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
  return { db, repository, cycle, match };
}

describe('feedback state transitions', () => {
  it('records met feedback and marks the match terminal', () => {
    const { db, repository, match } = setupRepository();
    const result = recordFeedbackAndUpdateMatch(repository, match.id, 'U1', 'met', '2026-06-04T08:00:00Z');

    expect(result.terminal).toBe(true);
    expect(repository.getMatch(match.id)!.outcome).toBe('met');
    expect(repository.listFeedbackForMatch(match.id)).toHaveLength(1);
    db.close();
  });

  it('records not-yet feedback and schedules a second reminder until the maximum is reached', () => {
    const { db, repository, match } = setupRepository();
    repository.incrementMatchReminderCount(match.id);

    const result = recordFeedbackAndUpdateMatch(repository, match.id, 'U1', 'not_yet', '2026-06-04T08:00:00Z');

    expect(result.terminal).toBe(false);
    expect(repository.getMatch(match.id)!.outcome).toBe('active');
    expect(repository.listDueReminders('2026-06-07T08:00:00Z')).toHaveLength(1);

    repository.incrementMatchReminderCount(match.id);
    const afterMax = recordFeedbackAndUpdateMatch(repository, match.id, 'U2', 'not_yet', '2026-06-08T08:00:00Z');
    expect(afterMax.text).toContain('maximum number of reminders');
    db.close();
  });

  it('expires the match when not-yet feedback arrives after cycle closure', () => {
    const { db, repository, cycle, match } = setupRepository();
    repository.closeCycle(cycle.id, 'completed', '2026-06-10T08:00:00Z');

    const result = recordFeedbackAndUpdateMatch(repository, match.id, 'U1', 'not_yet', '2026-06-11T08:00:00Z');

    expect(result.terminal).toBe(true);
    expect(repository.getMatch(match.id)!.outcome).toBe('expired');
    db.close();
  });
});

describe('notification retry state', () => {
  it('uses Slack retry-after when present', () => {
    expect(retryDelayMs({ data: { retryAfter: 7 } }, 0)).toBe(7000);
  });

  it('keeps failed notification jobs retryable without duplicating successful jobs', async () => {
    const { db, repository, match } = setupRepository();
    const job = repository.createNotificationJob({ type: 'pair_notification', matchId: match.id, userId: 'U1', nextAttemptAt: '2026-06-04T08:00:00Z' });
    const client = {
      conversations: { open: vi.fn(async () => ({ channel: { id: 'D1' } })) },
      chat: { postMessage: vi.fn(async () => ({ channel: 'D1', ts: '1.2' })) },
    };

    await processNotificationJobs(client, repository, createLogger('silent'), '2026-06-04T08:00:00Z');
    await processNotificationJobs(client, repository, createLogger('silent'), '2026-06-04T08:00:00Z');

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(repository.listDueNotificationJobs('2026-06-04T08:00:00Z')).toHaveLength(0);
    expect(repository.createNotificationJob({ type: 'pair_notification', matchId: match.id, userId: 'U1' }).id).toBe(job.id);
    db.close();
  });
});
