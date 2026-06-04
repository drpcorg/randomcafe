import type {
  AppConfig,
  CycleRecord,
  MatchRecord,
  SchedulingCandidateSlot,
  SchedulingMessage,
  SchedulingMessageRole,
  SchedulingNotificationJob,
  SchedulingNotificationType,
  SchedulingPreference,
  SchedulingRequest,
  SchedulingResponse,
  SchedulingResponseType,
  SchedulingSlotStatus,
  SchedulingStatus,
} from '../types.js';

export interface SchedulingStore {
  getConfig(): AppConfig | null;
  getMatch(matchId: number): MatchRecord | null;
  getCycleForMatch(matchId: number): CycleRecord | null;

  createSchedulingRequest(matchId: number, timestamp?: string): SchedulingRequest;
  getSchedulingRequest(requestId: number): SchedulingRequest | null;
  getSchedulingRequestByMatch(matchId: number): SchedulingRequest | null;
  listSchedulingRequestsByStatus(statuses: SchedulingStatus[], limit?: number): SchedulingRequest[];
  claimSchedulingRequest(requestId: number, owner: string, timestamp?: string, ttlMs?: number): SchedulingRequest | null;
  releaseSchedulingRequestClaim(requestId: number, owner: string): void;
  markSchedulingProposed(requestId: number, selectedSlotId?: string | null, timestamp?: string): void;
  markSchedulingManual(requestId: number, reason?: string | null, timestamp?: string, selectedSlotId?: string | null): void;
  markSchedulingBooked(requestId: number, slotId: string, providerEventId: string, providerEventUrl?: string | null, timestamp?: string): void;
  markSchedulingFailed(requestId: number, reason: string, timestamp?: string): void;
  expireSchedulingForMatch(matchId: number, timestamp?: string): void;

  getSchedulingPreference(slackUserId: string): SchedulingPreference | null;
  listSchedulingResponses(requestId: number): SchedulingResponse[];
  recordSchedulingResponse(params: { requestId: number; slackUserId: string; response: SchedulingResponseType; slotId?: string | null; text?: string | null }, timestamp?: string): SchedulingResponse;
  latestAcceptedUsersForSlot(requestId: number, slotId: string): Set<string>;

  saveCandidateSlots(requestId: number, slots: Array<Omit<SchedulingCandidateSlot, 'requestId' | 'createdAt' | 'status'> & { status?: SchedulingSlotStatus }>, timestamp?: string): SchedulingCandidateSlot[];
  listCandidateSlots(requestId: number, status?: SchedulingSlotStatus): SchedulingCandidateSlot[];
  getCandidateSlot(requestId: number, slotId: string): SchedulingCandidateSlot | null;
  markSlotsInactiveExcept(requestId: number, activeSlotIds: string[], timestamp?: string): void;

  addSchedulingMessage(requestId: number, role: SchedulingMessageRole, content: string, timestamp?: string): SchedulingMessage;
  listSchedulingMessages(requestId: number): SchedulingMessage[];

  createSchedulingNotificationJob(params: { type: SchedulingNotificationType; requestId: number; userId: string; slotId?: string | null; dedupeKey?: string; nextAttemptAt?: string; createdAt?: string }): SchedulingNotificationJob;
}
