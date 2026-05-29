import type { Logger } from 'pino';
import type { CafeRepository } from '../db.js';
import type { SchedulingNotificationJob } from '../types.js';
import { retryDelayMs, type SlackMessageClientLike } from './notifications.js';
import { schedulingBookedBlocks, schedulingFailedBlocks, schedulingManualBlocks, schedulingProposalBlocks, textForSchedulingJob } from './schedulingMessages.js';

async function openDm(client: SlackMessageClientLike, userId: string): Promise<string> {
  const response = await client.conversations.open({ users: userId });
  const channelId = response.channel?.id;
  if (!channelId) throw new Error(`Slack did not return a DM channel for ${userId}`);
  return channelId;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function blocksForJob(job: SchedulingNotificationJob, repository: CafeRepository): unknown[] {
  const request = repository.getSchedulingRequest(job.requestId);
  if (!request) return schedulingFailedBlocks('Random Coffee scheduling request was not found.');
  const selected = request.selectedSlotId ? repository.getCandidateSlot(request.id, request.selectedSlotId) : null;
  if (job.type === 'proposal') {
    const proposed = repository.listCandidateSlots(request.id, 'active').slice(0, 3);
    return schedulingProposalBlocks(request, proposed);
  }
  if (job.type === 'manual') return schedulingManualBlocks(request);
  if (job.type === 'booked') return schedulingBookedBlocks(selected);
  if (job.type === 'no_slots') return schedulingFailedBlocks('☕ I could not find a shared slot yet. You can suggest preferences or choose manual mode.');
  return schedulingFailedBlocks('☕ Automated scheduling is unavailable for this coffee match. Please arrange directly; reminders will continue.');
}

export async function sendSchedulingNotificationJob(client: SlackMessageClientLike, repository: CafeRepository, job: SchedulingNotificationJob): Promise<void> {
  const channelId = await openDm(client, job.userId);
  const response = await client.chat.postMessage({
    channel: channelId,
    text: textForSchedulingJob(job, repository),
    blocks: blocksForJob(job, repository),
  });
  repository.markSchedulingNotificationSent(job.id, response.channel ?? channelId, response.ts ?? '', new Date().toISOString());
}

export async function processSchedulingNotificationJobs(client: SlackMessageClientLike, repository: CafeRepository, logger: Logger, timestamp = new Date().toISOString()): Promise<number> {
  const jobs = repository.listDueSchedulingNotificationJobs(timestamp);
  let sent = 0;
  for (const job of jobs) {
    try {
      await sendSchedulingNotificationJob(client, repository, job);
      sent += 1;
    } catch (error) {
      const delayMs = retryDelayMs(error, job.attempts);
      const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
      repository.markSchedulingNotificationFailed(job.id, errorMessage(error), nextAttemptAt);
      logger.warn({ err: error, jobId: job.id, type: job.type, nextAttemptAt }, 'Slack scheduling notification send failed; queued for retry');
    }
  }
  return sent;
}
