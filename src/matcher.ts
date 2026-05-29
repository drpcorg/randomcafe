import type { MatchPair, MatchPlan, PairHistoryEntry, Participant } from './types.js';
import { normalizePair } from './db.js';

export type RandomFn = () => number;

export const SCORE_NEVER_MET = 0;
export const SCORE_OLDER = 1;
export const SCORE_MID_RECENT = 5;
export const SCORE_RECENT = 25;
export const SCORE_PREVIOUS = 100;

export function pairKey(userA: string, userB: string): string {
  const pair = normalizePair(userA, userB);
  return `${pair.userA}:${pair.userB}`;
}

export function buildPairHistoryMap(history: PairHistoryEntry[]): Map<string, number> {
  return new Map(history.map((entry) => [pairKey(entry.userA, entry.userB), entry.lastSequence]));
}

export function scorePair(userA: string, userB: string, currentSequence: number, historyByPair: Map<string, number>): number {
  const lastSequence = historyByPair.get(pairKey(userA, userB));
  if (lastSequence == null) return SCORE_NEVER_MET;

  const completedCyclesAgo = currentSequence - lastSequence;
  if (completedCyclesAgo <= 1) return SCORE_PREVIOUS;
  if (completedCyclesAgo === 2) return SCORE_RECENT;
  if (completedCyclesAgo >= 3 && completedCyclesAgo <= 5) return SCORE_MID_RECENT;
  return SCORE_OLDER;
}

export function scorePairs(pairs: MatchPair[], currentSequence: number, historyByPair: Map<string, number>): number {
  return pairs.reduce((total, pair) => total + scorePair(pair.userA, pair.userB, currentSequence, historyByPair), 0);
}

export function shuffle<T>(items: readonly T[], random: RandomFn = Math.random): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}

export function selectSkippedUser(participants: readonly Participant[], skipHistory: Map<string, string>, random: RandomFn = Math.random): string | undefined {
  if (participants.length % 2 === 0) return undefined;
  if (participants.length === 0) return undefined;

  const neverSkipped = participants.filter((participant) => !skipHistory.has(participant.slackUserId));
  if (neverSkipped.length > 0) {
    return neverSkipped[Math.floor(random() * neverSkipped.length)]!.slackUserId;
  }

  const sorted = [...participants].sort((left, right) => {
    const leftSkipped = skipHistory.get(left.slackUserId)!;
    const rightSkipped = skipHistory.get(right.slackUserId)!;
    return leftSkipped.localeCompare(rightSkipped);
  });
  const oldest = skipHistory.get(sorted[0]!.slackUserId)!;
  const tiedOldest = sorted.filter((participant) => skipHistory.get(participant.slackUserId) === oldest);
  return tiedOldest[Math.floor(random() * tiedOldest.length)]!.slackUserId;
}

export function generateCandidatePairs(participants: readonly Participant[], random: RandomFn = Math.random): MatchPair[] {
  const shuffled = shuffle(participants, random);
  const pairs: MatchPair[] = [];
  for (let index = 0; index + 1 < shuffled.length; index += 2) {
    const first = shuffled[index]!;
    const second = shuffled[index + 1]!;
    pairs.push(normalizePair(first.slackUserId, second.slackUserId));
  }
  return pairs;
}

export interface PlanMatchesInput {
  participants: Participant[];
  currentSequence: number;
  pairHistory: PairHistoryEntry[];
  skipHistory: Map<string, string>;
  candidateAttempts: number;
  random?: RandomFn;
}

export function planMatches(input: PlanMatchesInput): MatchPlan {
  const random = input.random ?? Math.random;
  const skippedUserId = selectSkippedUser(input.participants, input.skipHistory, random);
  const pairableParticipants = skippedUserId
    ? input.participants.filter((participant) => participant.slackUserId !== skippedUserId)
    : [...input.participants];

  if (pairableParticipants.length < 2) {
    return { pairs: [], skippedUserId, score: 0, attemptedCandidates: 0 };
  }

  const hasMultipleArrangements = pairableParticipants.length >= 4;
  const attempts = hasMultipleArrangements ? Math.max(200, input.candidateAttempts) : 1;
  const historyByPair = buildPairHistoryMap(input.pairHistory);

  let bestPairs: MatchPair[] = [];
  let bestScore = Number.POSITIVE_INFINITY;
  const tiedBest: MatchPair[][] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pairs = generateCandidatePairs(pairableParticipants, random);
    const score = scorePairs(pairs, input.currentSequence, historyByPair);
    if (score < bestScore) {
      bestScore = score;
      bestPairs = pairs;
      tiedBest.length = 0;
      tiedBest.push(pairs);
    } else if (score === bestScore) {
      tiedBest.push(pairs);
    }
  }

  if (tiedBest.length > 1) {
    bestPairs = tiedBest[Math.floor(random() * tiedBest.length)]!;
  }

  return {
    pairs: bestPairs,
    skippedUserId,
    score: bestScore,
    attemptedCandidates: attempts,
  };
}
