import type { Logger } from 'pino';
import { CafeRepository, nowIso } from './db.js';
import { planMatches } from './matcher.js';
import { addDaysUtc, scheduledAtForSequence } from './schedule.js';
import type { AppConfig, CycleRecord } from './types.js';
import { ParticipantPoolError, resolveParticipantPool, type SlackWebClientLike } from './slack/participantPool.js';
import { createPairNotificationJobs, scheduleFirstReminder } from './slack/notifications.js';
import type { SchedulingCoordinator } from './scheduling.js';

export interface CycleProcessorClient extends SlackWebClientLike {}

export interface ProcessDueCyclesResult {
  created: number;
  skippedExisting: number;
  failed: number;
}

export async function createCycleForSchedule(
  client: CycleProcessorClient,
  repository: CafeRepository,
  config: AppConfig,
  scheduledAt: string,
  sequence: number,
  logger: Logger,
  schedulingCoordinator?: SchedulingCoordinator,
): Promise<CycleRecord | null> {
  const existing = repository.getCycleByScheduledAt(scheduledAt);
  if (existing) return null;

  let participants;
  try {
    participants = await resolveParticipantPool(client, repository, config);
  } catch (error) {
    if (error instanceof ParticipantPoolError) {
      return repository.transaction(() => {
        const cycle = repository.createCycle(scheduledAt, sequence, 'failed', error.message);
        repository.failCycle(cycle.id, error.message);
        return repository.getCycleByScheduledAt(scheduledAt)!;
      });
    }
    logger.error({ err: error, scheduledAt }, 'Could not resolve participant pool; cycle was not created');
    throw error;
  }

  return repository.transaction(() => {
    for (const openCycle of repository.listOpenCyclesBefore(scheduledAt)) {
      repository.expireActiveMatchesForCycle(openCycle.id);
      repository.closeCycle(openCycle.id, 'completed');
    }

    const cycle = repository.createCycle(scheduledAt, sequence, 'open');

    if (participants.length < 2) {
      logger.info({ cycleId: cycle.id, participants: participants.length }, 'Cycle created without pairs because fewer than two participants are eligible');
      return cycle;
    }

    const plan = planMatches({
      participants,
      currentSequence: cycle.sequence,
      pairHistory: repository.getPairHistory(cycle.sequence),
      skipHistory: repository.getSkipHistory(),
      candidateAttempts: config.matchCandidateAttempts,
    });

    if (plan.skippedUserId) {
      repository.recordSkippedParticipant(cycle.id, plan.skippedUserId);
    }

    for (const pair of plan.pairs) {
      const match = repository.createMatch(cycle.id, pair.userA, pair.userB);
      const schedulingRequest = schedulingCoordinator?.createRequestForMatch(match);
      if (!schedulingRequest) createPairNotificationJobs(repository, match);
      scheduleFirstReminder(repository, match, scheduledAt, config.reminderDelayDays);
    }

    logger.info({ cycleId: cycle.id, pairs: plan.pairs.length, skippedUserId: plan.skippedUserId, score: plan.score }, 'Created Random Coffee cycle');
    return cycle;
  });
}

function dueUncreatedScheduledTimes(
  repository: CafeRepository,
  config: Pick<AppConfig, 'firstPairingLocal' | 'timezone' | 'frequency'>,
  timestamp: string,
  maxCount = 10,
  maxScheduleOccurrences = 1000,
): Array<{ scheduledAt: string }> {
  const due: Array<{ scheduledAt: string }> = [];
  const dueEpochMs = new Set<number>();
  const nowMs = Date.parse(timestamp);

  const addIfUncreated = (scheduledAt: string): void => {
    const scheduledMs = Date.parse(scheduledAt);
    if (Number.isNaN(scheduledMs) || scheduledMs > nowMs || dueEpochMs.has(scheduledMs)) return;
    if (repository.getCycleByScheduledAt(scheduledAt)) return;
    due.push({ scheduledAt });
    dueEpochMs.add(scheduledMs);
  };

  const lastCycle = repository.getLastCycle();
  if (lastCycle) {
    const lastScheduledMs = Date.parse(lastCycle.scheduledAt);
    const intervalDays = config.frequency === 'weekly' ? 7 : 14;

    let nextScheduledAt = addDaysUtc(lastCycle.scheduledAt, intervalDays);
    while (due.length < maxCount && Date.parse(nextScheduledAt) <= nowMs) {
      addIfUncreated(nextScheduledAt);
      nextScheduledAt = addDaysUtc(nextScheduledAt, intervalDays);
    }

    return due;
  }

  // No cycles yet: fall back to firstPairingLocal.
  for (let scheduleSequence = 1; due.length < maxCount && scheduleSequence <= maxScheduleOccurrences; scheduleSequence += 1) {
    const scheduledAt = scheduledAtForSequence(config, scheduleSequence);
    addIfUncreated(scheduledAt);
    if (Date.parse(scheduledAt) > nowMs) break;
  }

  return due;
}

export async function processDueCycles(
  client: CycleProcessorClient,
  repository: CafeRepository,
  logger: Logger,
  timestamp = nowIso(),
  schedulingCoordinator?: SchedulingCoordinator,
): Promise<ProcessDueCyclesResult> {
  const config = repository.getConfig();
  if (!config) return { created: 0, skippedExisting: 0, failed: 0 };

  const lastCycle = repository.getLastCycle();
  const due = dueUncreatedScheduledTimes(repository, config, timestamp);
  const result: ProcessDueCyclesResult = { created: 0, skippedExisting: 0, failed: 0 };
  let nextCycleSequence = (lastCycle?.sequence ?? 0) + 1;

  for (const item of due) {
    try {
      const created = await createCycleForSchedule(client, repository, config, item.scheduledAt, nextCycleSequence, logger, schedulingCoordinator);
      if (!created) {
        result.skippedExisting += 1;
        continue;
      }

      nextCycleSequence += 1;
      if (created.status === 'failed') {
        result.failed += 1;
      } else {
        result.created += 1;
      }
    } catch (error) {
      logger.error({ err: error, scheduledAt: item.scheduledAt }, 'Due cycle processing failed');
      throw error;
    }
  }

  return result;
}
