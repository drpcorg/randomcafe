import type { Logger } from 'pino';
import type { CafeRepository } from '../db.js';
import type { SchedulingNotificationJob } from '../types.js';
import { retryDelayMs, type SlackMessageClientLike } from './notifications.js';
import type { SlackWebClientLike } from './participantPool.js';
import { schedulingBookedBlocks, schedulingFailedBlocks, schedulingManualBlocks, schedulingProposalBlocks, textForSchedulingJob } from './schedulingMessages.js';

export interface SlackSchedulingNotificationClientLike extends SlackMessageClientLike {
  users?: SlackWebClientLike['users'];
}

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

function sectionBlocks(text: string): unknown[] {
  return [{ type: 'section', text: { type: 'mrkdwn', text } }];
}

export function schedulingSelectionSavedText(slotCount: number): string {
  return `✅ *Selection saved.*\n${slotCount} option(s) work for you. I’ll book automatically if your coffee partner selected any of the same slots.`;
}

export const schedulingAlternativesRequestedText = '🔁 *Looking for other options.*\nI’ll send a fresh set of proposed times shortly.';
export const schedulingSuggestTimeRequestedText = '✍️ *Waiting for your scheduling note.*\nI opened a preference form. Once you submit it, I’ll send a fresh set of proposed times.';
export const schedulingManualModeChosenText = '🤝 *Manual mode enabled.*\nPlease arrange directly; reminders will continue.';

export async function updateSchedulingInteractionMessage(client: SlackSchedulingNotificationClientLike, body: any, text: string, respond?: ((message: any) => Promise<unknown>) | null): Promise<boolean> {
  const blocks = sectionBlocks(text);
  const channel = body?.channel?.id;
  const ts = body?.message?.ts;

  // For bot-authored proposal messages, chat.update is the most deterministic
  // way to remove stale controls. response_url/respond can succeed while not
  // replacing the original message in some Slack clients.
  if (channel && ts && client.chat.update) {
    await client.chat.update({ channel, ts, text, blocks });
    return true;
  }

  if (respond) {
    await respond({ replace_original: true, text, blocks });
    return true;
  }
  return false;
}

async function userTimezone(client: SlackSchedulingNotificationClientLike, repository: CafeRepository, userId: string): Promise<string> {
  if (client.users) {
    const response = await client.users.info({ user: userId }).catch(() => null);
    const timezone = response?.user?.tz;
    if (timezone) return timezone;
  }
  return repository.getConfig()?.timezone ?? 'UTC';
}

async function blocksForJob(client: SlackSchedulingNotificationClientLike, job: SchedulingNotificationJob, repository: CafeRepository): Promise<unknown[]> {
  const request = repository.getSchedulingRequest(job.requestId);
  if (!request) return schedulingFailedBlocks('Random Coffee scheduling request was not found.');
  const selected = request.selectedSlotId ? repository.getCandidateSlot(request.id, request.selectedSlotId) : null;
  const match = repository.getMatch(request.matchId);
  const partnerUserId = match ? (job.userId === match.userA ? match.userB : match.userA) : null;
  const timezone = await userTimezone(client, repository, job.userId);
  if (job.type === 'proposal') {
    const proposed = repository.listCandidateSlots(request.id, 'active').slice(0, 3);
    const explanation = repository.listSchedulingMessages(request.id).filter((message) => message.role === 'assistant').at(-1)?.content ?? null;
    return schedulingProposalBlocks(request, proposed, partnerUserId, timezone, explanation);
  }
  if (job.type === 'manual') return schedulingManualBlocks(request, selected, partnerUserId, timezone);
  if (job.type === 'booked') return schedulingBookedBlocks(selected, timezone, request.providerEventUrl);
  if (job.type === 'no_slots') return schedulingFailedBlocks('☕ I could not find a shared slot yet. You can suggest preferences or choose manual mode.');
  return schedulingFailedBlocks('☕ Automated scheduling is unavailable for this coffee match. Please arrange directly; reminders will continue.');
}

function latestAssistantReason(repository: CafeRepository, requestId: number): string | null {
  return repository.listSchedulingMessages(requestId).filter((message) => message.role === 'assistant').at(-1)?.content?.trim() || null;
}

function staleProposalText(job: SchedulingNotificationJob, repository: CafeRepository): string {
  if (job.type === 'proposal') {
    const reason = latestAssistantReason(repository, job.requestId);
    return `🔁 *This proposal is no longer active.*\n${reason ? `Reason: ${reason}\n` : ''}I sent a fresh set of proposed times below.`;
  }
  if (job.type === 'booked') return '✅ *This proposal is no longer active.*\nThe meeting has been booked. See the booking update below.';
  if (job.type === 'manual') return '🤝 *This proposal is no longer active.*\nManual mode is enabled. See the update below.';
  if (job.type === 'no_slots') return '🔁 *This proposal is no longer active.*\nI could not find fresh shared slots. See the update below.';
  return '⚠️ *This proposal is no longer active.*\nAutomated scheduling is unavailable. See the update below.';
}

async function deactivateLatestProposal(client: SlackSchedulingNotificationClientLike, repository: CafeRepository, job: SchedulingNotificationJob): Promise<void> {
  if (!client.chat.update) return;
  const proposal = repository.findLatestSentSchedulingNotificationJob({ requestId: job.requestId, userId: job.userId, type: 'proposal' });
  if (!proposal?.slackChannelId || !proposal.slackTs) return;
  const text = staleProposalText(job, repository);
  await client.chat.update({ channel: proposal.slackChannelId, ts: proposal.slackTs, text, blocks: sectionBlocks(text) });
}

export async function sendSchedulingNotificationJob(client: SlackSchedulingNotificationClientLike, repository: CafeRepository, job: SchedulingNotificationJob): Promise<void> {
  await deactivateLatestProposal(client, repository, job);

  const text = textForSchedulingJob(job, repository);
  const blocks = await blocksForJob(client, job, repository);
  const channelId = await openDm(client, job.userId);
  const response = await client.chat.postMessage({ channel: channelId, text, blocks });
  repository.markSchedulingNotificationSent(job.id, response.channel ?? channelId, response.ts ?? '', new Date().toISOString());
}

let schedulingNotificationDeliveryRunning = false;

export async function processSchedulingNotificationJobs(client: SlackSchedulingNotificationClientLike, repository: CafeRepository, logger: Logger, timestamp = new Date().toISOString()): Promise<number> {
  if (schedulingNotificationDeliveryRunning) return 0;
  schedulingNotificationDeliveryRunning = true;
  try {
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
  } finally {
    schedulingNotificationDeliveryRunning = false;
  }
}
