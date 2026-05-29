import { nowIso, type CafeRepository } from './db.js';
import { addDaysUtc } from './schedule.js';
import type { FeedbackOutcome } from './types.js';

export interface FeedbackResult {
  text: string;
  terminal: boolean;
}

export function recordFeedbackAndUpdateMatch(repository: CafeRepository, matchId: number, responderUserId: string, outcome: FeedbackOutcome, timestamp = nowIso()): FeedbackResult {
  return repository.transaction(() => {
    const match = repository.getMatch(matchId);
    if (!match) {
      throw new Error(`Match ${matchId} not found`);
    }

    repository.recordFeedback(matchId, responderUserId, outcome, timestamp);

    if (match.outcome !== 'active') {
      return { text: `Thanks! This coffee pair is already marked as *${match.outcome}*.`, terminal: true };
    }

    if (outcome === 'met') {
      repository.updateMatchOutcome(matchId, 'met', timestamp);
      return { text: '✅ Thanks! Marked this Random Coffee as *met*.', terminal: true };
    }

    if (outcome === 'cannot_meet') {
      repository.updateMatchOutcome(matchId, 'cancelled', timestamp);
      return { text: '❌ Thanks! Marked this Random Coffee as *cannot meet*.', terminal: true };
    }

    const config = repository.getConfig();
    const cycle = repository.getCycleForMatch(matchId);
    if (!config || !cycle || cycle.status !== 'open') {
      repository.updateMatchOutcome(matchId, 'expired', timestamp);
      return { text: '⏳ Thanks! This cycle is no longer open, so no more reminders will be sent.', terminal: true };
    }

    const current = repository.getMatch(matchId)!;
    if (current.reminderCount >= config.maxRemindersPerMatch) {
      return { text: '⏳ Thanks! Noted. The maximum number of reminders has already been reached.', terminal: false };
    }

    const nextSequence = current.reminderCount + 1;
    const dueAt = addDaysUtc(timestamp, config.reminderDelayDays);
    repository.createReminder(matchId, nextSequence, dueAt, timestamp);
    return { text: '⏳ Thanks! Noted as *not yet*. I will remind you again later.', terminal: false };
  });
}
