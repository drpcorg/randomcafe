import { describe, expect, it } from 'vitest';
import { buildPairHistoryMap, planMatches, scorePair, SCORE_MID_RECENT, SCORE_NEVER_MET, SCORE_OLDER, SCORE_PREVIOUS, SCORE_RECENT, selectSkippedUser } from '../src/matcher.js';
import type { Participant } from '../src/types.js';

const participants = (...ids: string[]): Participant[] => ids.map((id) => ({ slackUserId: id }));

function sequenceRandom(values: number[]) {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

describe('matcher scoring', () => {
  it('scores never-met, older, recent, and previous-cycle pairings', () => {
    const history = buildPairHistoryMap([
      { userA: 'U1', userB: 'U2', lastSequence: 9 },
      { userA: 'U1', userB: 'U3', lastSequence: 8 },
      { userA: 'U1', userB: 'U4', lastSequence: 6 },
      { userA: 'U1', userB: 'U5', lastSequence: 3 },
    ]);

    expect(scorePair('U9', 'U10', 10, history)).toBe(SCORE_NEVER_MET);
    expect(scorePair('U1', 'U2', 10, history)).toBe(SCORE_PREVIOUS);
    expect(scorePair('U1', 'U3', 10, history)).toBe(SCORE_RECENT);
    expect(scorePair('U1', 'U4', 10, history)).toBe(SCORE_MID_RECENT);
    expect(scorePair('U1', 'U5', 10, history)).toBe(SCORE_OLDER);
  });

  it('attempts at least 200 candidates when multiple arrangements are possible', () => {
    const plan = planMatches({
      participants: participants('U1', 'U2', 'U3', 'U4'),
      currentSequence: 1,
      pairHistory: [],
      skipHistory: new Map(),
      candidateAttempts: 3,
      random: sequenceRandom([0.1, 0.2, 0.3, 0.4]),
    });

    expect(plan.attemptedCandidates).toBe(200);
    expect(plan.pairs).toHaveLength(2);
  });

  it('selects never-skipped participants before recently skipped participants', () => {
    const skipped = selectSkippedUser(
      participants('U1', 'U2', 'U3'),
      new Map([
        ['U1', '2026-01-02T00:00:00Z'],
        ['U2', '2026-01-01T00:00:00Z'],
      ]),
      () => 0,
    );

    expect(skipped).toBe('U3');
  });

  it('selects the oldest skipped participant when everyone has skip history', () => {
    const skipped = selectSkippedUser(
      participants('U1', 'U2', 'U3'),
      new Map([
        ['U1', '2026-01-03T00:00:00Z'],
        ['U2', '2026-01-01T00:00:00Z'],
        ['U3', '2026-01-02T00:00:00Z'],
      ]),
      () => 0,
    );

    expect(skipped).toBe('U2');
  });
});
