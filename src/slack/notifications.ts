import type { Logger } from 'pino';
import type { CafeRepository } from '../db.js';
import { addDaysUtc } from '../schedule.js';
import type { MatchRecord, NotificationJob } from '../types.js';
import { messageTextForJob, pairNotificationBlocks, reminderBlocks } from './messages.js';

export interface SlackMessageClientLike {
  conversations: {
    open(args: { users: string }): Promise<{ channel?: { id?: string } }>;
  };
  chat: {
    postMessage(args: { channel: string; text: string; blocks?: unknown[] }): Promise<{ channel?: string; ts?: string }>;
    update?(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<{ channel?: string; ts?: string }>;
  };
}

export function retryDelayMs(error: unknown, attempts: number): number {
  const data = (error as { data?: { retryAfter?: number } })?.data;
  const retryAfter = data?.retryAfter ?? (error as { retryAfter?: number })?.retryAfter;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createPairNotificationJobs(repository: CafeRepository, match: MatchRecord): void {
  repository.createNotificationJob({ type: 'pair_notification', matchId: match.id, userId: match.userA });
  repository.createNotificationJob({ type: 'pair_notification', matchId: match.id, userId: match.userB });
}

export function scheduleFirstReminder(repository: CafeRepository, match: MatchRecord, cycleScheduledAt: string, reminderDelayDays: number): void {
  const dueAt = addDaysUtc(cycleScheduledAt, reminderDelayDays);
  repository.createReminder(match.id, 1, dueAt);
}

export function enqueueReminderJobs(repository: CafeRepository, match: MatchRecord, reminderId: number): void {
  repository.createNotificationJob({ type: 'reminder', matchId: match.id, userId: match.userA, reminderId });
  repository.createNotificationJob({ type: 'reminder', matchId: match.id, userId: match.userB, reminderId });
}

async function openDm(client: SlackMessageClientLike, userId: string): Promise<string> {
  const response = await client.conversations.open({ users: userId });
  const channelId = response.channel?.id;
  if (!channelId) throw new Error(`Slack did not return a DM channel for ${userId}`);
  return channelId;
}

function blocksForJob(job: NotificationJob, match: MatchRecord): unknown[] {
  return job.type === 'pair_notification' ? pairNotificationBlocks(match, job.userId) : reminderBlocks(match);
}

export async function sendNotificationJob(client: SlackMessageClientLike, repository: CafeRepository, job: NotificationJob): Promise<void> {
  const match = repository.getMatch(job.matchId);
  if (!match) {
    repository.markJobFailed(job.id, `Match ${job.matchId} not found`, new Date(Date.now() + retryDelayMs(new Error('missing match'), job.attempts)).toISOString());
    return;
  }

  const channelId = await openDm(client, job.userId);
  const response = await client.chat.postMessage({
    channel: channelId,
    text: messageTextForJob(job, match),
    blocks: blocksForJob(job, match),
  });
  repository.markJobSent(job.id, response.channel ?? channelId, response.ts ?? '', new Date().toISOString());
}

export async function processDueReminderRows(repository: CafeRepository, timestamp = new Date().toISOString()): Promise<number> {
  let enqueued = 0;
  const reminders = repository.listDueReminders(timestamp);
  for (const reminder of reminders) {
    const match = repository.getMatch(reminder.matchId);
    const cycle = repository.getCycleForMatch(reminder.matchId);
    if (!match || !cycle || match.outcome !== 'active' || cycle.status !== 'open') {
      repository.markReminderSent(reminder.id, timestamp);
      continue;
    }
    enqueueReminderJobs(repository, match, reminder.id);
    repository.incrementMatchReminderCount(match.id);
    repository.markReminderSent(reminder.id, timestamp);
    enqueued += 1;
  }
  return enqueued;
}

export async function processNotificationJobs(client: SlackMessageClientLike, repository: CafeRepository, logger: Logger, timestamp = new Date().toISOString()): Promise<number> {
  const jobs = repository.listDueNotificationJobs(timestamp);
  let sent = 0;
  for (const job of jobs) {
    try {
      await sendNotificationJob(client, repository, job);
      sent += 1;
    } catch (error) {
      const delayMs = retryDelayMs(error, job.attempts);
      const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
      repository.markJobFailed(job.id, errorMessage(error), nextAttemptAt);
      logger.warn({ err: error, jobId: job.id, type: job.type, nextAttemptAt }, 'Slack notification send failed; queued for retry');
    }
  }
  return sent;
}
