import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { mapWithConcurrency } from '../asyncQueue.js';
import { defaultSchedulingPreference, type CalendarService, type SchedulingParticipantProfile } from '../calendar/service.js';
import type { MatchRecord, RuntimeConfig, SchedulingCandidateSlot, SchedulingNotificationType, SchedulingRequest, SchedulingResponseType } from '../types.js';
import { SchedulingAgent, type SchedulingRecommendation } from './agent.js';
import { RepositorySchedulingEnvironment, type SchedulingEnvironment } from './environment.js';
import type { SchedulingStore } from './store.js';

export interface SchedulingResponseInput {
  requestId: number;
  userId: string;
  response: SchedulingResponseType;
  slotId?: string | null;
  slotIds?: string[] | null;
  text?: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function terminal(status: SchedulingRequest['status']): boolean {
  return status === 'booked' || status === 'manual' || status === 'failed' || status === 'expired';
}

function dedupeSuffix(): string {
  return crypto.randomUUID();
}

export class SchedulingCoordinator {
  private readonly agent: SchedulingAgent;
  private readonly environment: SchedulingEnvironment;

  constructor(
    private readonly store: SchedulingStore,
    readonly config: RuntimeConfig,
    private readonly calendar: CalendarService,
    private readonly logger: Logger,
    environment?: SchedulingEnvironment,
  ) {
    this.environment = environment ?? new RepositorySchedulingEnvironment(store);
    this.agent = new SchedulingAgent(store, config);
  }

  createRequestForMatch(match: MatchRecord): SchedulingRequest | null {
    if (!this.config.calendarSchedulingEnabled) return null;
    return this.store.createSchedulingRequest(match.id);
  }

  async processPendingRequests(timestamp = nowIso()): Promise<number> {
    if (!this.config.calendarSchedulingEnabled) return 0;
    const requests = this.store.listSchedulingRequestsByStatus(['pending'], 100);
    const processed = await mapWithConcurrency(requests, this.config.schedulingPlanningConcurrency, async (request) => {
      const owner = `scheduler:${process.pid}:${dedupeSuffix()}`;
      const claimed = this.store.claimSchedulingRequest(request.id, owner, timestamp);
      if (!claimed) return 0;
      try {
        await this.planRequest(claimed, 'initial', timestamp);
        return 1;
      } finally {
        this.store.releaseSchedulingRequestClaim(request.id, owner);
      }
    });
    return processed.filter(Boolean).length;
  }

  async handleParticipantResponse(input: SchedulingResponseInput, timestamp = nowIso()): Promise<SchedulingRequest | null> {
    const request = this.store.getSchedulingRequest(input.requestId);
    if (!request || terminal(request.status)) return request;

    if (input.response === 'manual') {
      this.store.recordSchedulingResponse({ requestId: input.requestId, slackUserId: input.userId, response: 'manual', text: input.text ?? null }, timestamp);
      this.store.markSchedulingManual(input.requestId, 'Participant chose manual mode', timestamp);
      await this.notifyParticipants(input.requestId, 'manual', null, `manual:${input.requestId}:${dedupeSuffix()}`, timestamp);
      return this.store.getSchedulingRequest(input.requestId);
    }

    if (input.response === 'accepted') {
      const requestedSlotIds = input.slotIds?.length ? input.slotIds : input.slotId ? [input.slotId] : [];
      const slots = [...new Set(requestedSlotIds)]
        .map((slotId) => this.store.getCandidateSlot(input.requestId, slotId))
        .filter((slot): slot is SchedulingCandidateSlot => Boolean(slot && slot.status === 'active'));
      if (slots.length === 0) return request;

      for (const active of this.store.listCandidateSlots(input.requestId, 'active')) {
        this.store.recordSchedulingResponse({ requestId: input.requestId, slackUserId: input.userId, response: 'rejected', slotId: active.id, text: 'Selection updated' }, timestamp);
      }
      for (const slot of slots) {
        this.store.recordSchedulingResponse({ requestId: input.requestId, slackUserId: input.userId, response: 'accepted', slotId: slot.id, text: input.text ?? null }, timestamp);
      }

      const match = this.store.getMatch(request.matchId);
      const compatible = match ? this.compatibleAcceptedSlot(input.requestId, match) : null;
      if (compatible) {
        await this.bookAcceptedSlot(request, compatible, timestamp);
      } else if (match && this.participantsAcceptedDifferentSlots(input.requestId, match)) {
        await this.replanAfterIncompatibleAcceptances(request, timestamp);
      }
      return this.store.getSchedulingRequest(input.requestId);
    }

    this.store.recordSchedulingResponse({ requestId: input.requestId, slackUserId: input.userId, response: input.response, slotId: input.slotId ?? null, text: input.text ?? null }, timestamp);
    if (input.response === 'alternatives') this.rejectActiveSlots(input.requestId, 'Participant requested other options', timestamp);
    await this.planRequest(request, input.text?.trim() || input.response, timestamp);
    return this.store.getSchedulingRequest(input.requestId);
  }

  expireSchedulingForClosedMatches(timestamp = nowIso()): number {
    let expired = 0;
    for (const request of this.store.listSchedulingRequestsByStatus(['pending', 'proposed'], 100)) {
      const match = this.store.getMatch(request.matchId);
      const cycle = this.store.getCycleForMatch(request.matchId);
      if (!match || match.outcome !== 'active' || !cycle || cycle.status !== 'open') {
        this.store.expireSchedulingForMatch(request.matchId, timestamp);
        expired += 1;
      }
    }
    return expired;
  }

  private async participantProfiles(match: MatchRecord): Promise<SchedulingParticipantProfile[]> {
    const users = [match.userA, match.userB];
    return Promise.all(users.map(async (slackUserId) => {
      const preference = this.store.getSchedulingPreference(slackUserId) ?? defaultSchedulingPreference(slackUserId, this.config);
      const identity = preference.automatedSchedulingEnabled ? await this.calendar.resolveAvailabilityIdentity(slackUserId) : null;
      const inviteAddress = await this.calendar.resolveInviteAddress(slackUserId);
      return { slackUserId, identity, inviteAddress, preference };
    }));
  }

  private async planRequest(request: SchedulingRequest, reason: string, timestamp = nowIso()): Promise<void> {
    const current = this.store.getSchedulingRequest(request.id);
    if (!current || terminal(current.status)) return;
    const match = this.store.getMatch(request.matchId);
    if (!match || match.outcome !== 'active') {
      this.store.expireSchedulingForMatch(request.matchId, timestamp);
      return;
    }
    const profiles = await this.participantProfiles(match);
    const optedIn = profiles.filter((profile) => profile.identity && profile.preference.automatedSchedulingEnabled);
    if (optedIn.length === 0) {
      this.store.markSchedulingManual(request.id, 'No participants opted into automated calendar scheduling', timestamp);
      await this.notifyParticipants(request.id, 'manual', null, `manual:${request.id}:no-opt-in`, timestamp);
      return;
    }

    const rejected = new Set(this.store.listSchedulingResponses(request.id).filter((response) => response.response === 'rejected' && response.slotId).map((response) => response.slotId!));
    const timezone = this.store.getConfig()?.timezone ?? 'UTC';
    const slots = await this.calendar.findSharedSlots({ requestId: request.id, participants: profiles, timezone, now: timestamp, rejectedSlotIds: rejected });
    if (slots.length === 0 && this.config.calendarAgentFallbackMode === 'failed') {
      this.store.markSchedulingFailed(request.id, 'No shared slots found', timestamp);
      await this.notifyParticipants(request.id, 'failed', null, `failed:${request.id}:no-slots`, timestamp);
      return;
    }
    if (slots.length === 0) {
      this.store.markSchedulingProposed(request.id, null, timestamp);
      await this.notifyParticipants(request.id, 'no_slots', null, `no-slots:${request.id}:${dedupeSuffix()}`, timestamp);
      return;
    }

    this.store.saveCandidateSlots(request.id, slots, timestamp);
    const activeSlotIds = slots.map((slot) => slot.id);
    this.store.markSlotsInactiveExcept(request.id, activeSlotIds, timestamp);
    let recommendation: SchedulingRecommendation;
    try {
      recommendation = await this.recommend(request);
    } catch (error) {
      if (this.config.calendarAgentFallbackMode === 'failed') {
        this.store.markSchedulingFailed(request.id, `Pi scheduling agent unavailable: ${error instanceof Error ? error.message : String(error)}`, timestamp);
        await this.notifyParticipants(request.id, 'failed', null, `failed:${request.id}:agent`, timestamp);
      } else {
        this.store.markSchedulingManual(request.id, `Pi scheduling agent unavailable: ${error instanceof Error ? error.message : String(error)}`, timestamp);
        await this.notifyParticipants(request.id, 'manual', null, `manual:${request.id}:agent`, timestamp);
      }
      return;
    }
    const proposedSlotIds = recommendation.slotIds;
    this.store.markSlotsInactiveExcept(request.id, proposedSlotIds, timestamp);
    this.store.addSchedulingMessage(request.id, 'assistant', recommendation.message, timestamp);
    this.store.markSchedulingProposed(request.id, null, timestamp);
    await this.notifyParticipants(request.id, 'proposal', null, `proposal:${request.id}:${proposedSlotIds.join(',')}:${dedupeSuffix()}`, timestamp);
    this.logger.info({ requestId: request.id, reason, proposedSlotIds }, 'Created scheduling proposal');
  }

  private async recommend(request: SchedulingRequest): Promise<SchedulingRecommendation> {
    try {
      return await this.agent.recommend(request);
    } catch (error) {
      this.store.addSchedulingMessage(request.id, 'system', `Pi scheduling agent unavailable: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private latestAcceptedSlotIds(requestId: number, userId: string): Set<string> {
    const accepted = new Set<string>();
    for (const response of this.store.listSchedulingResponses(requestId).filter((item) => item.slackUserId === userId)) {
      if (response.response === 'accepted' && response.slotId) {
        const slot = this.store.getCandidateSlot(requestId, response.slotId);
        if (slot?.status === 'active') accepted.add(response.slotId);
        continue;
      }
      if (response.response === 'rejected' || response.response === 'alternatives' || response.response === 'manual' || response.response === 'text_preference') {
        if (response.slotId) accepted.delete(response.slotId);
        else accepted.clear();
      }
    }
    return accepted;
  }

  private compatibleAcceptedSlot(requestId: number, match: MatchRecord): SchedulingCandidateSlot | null {
    const first = this.latestAcceptedSlotIds(requestId, match.userA);
    const second = this.latestAcceptedSlotIds(requestId, match.userB);
    if (first.size === 0 || second.size === 0) return null;
    return this.store.listCandidateSlots(requestId, 'active').find((slot) => first.has(slot.id) && second.has(slot.id)) ?? null;
  }

  private participantsAcceptedDifferentSlots(requestId: number, match: MatchRecord): boolean {
    const first = this.latestAcceptedSlotIds(requestId, match.userA);
    const second = this.latestAcceptedSlotIds(requestId, match.userB);
    return first.size > 0 && second.size > 0 && ![...first].some((slotId) => second.has(slotId));
  }

  private rejectActiveSlots(requestId: number, reason: string, timestamp = nowIso()): void {
    for (const slot of this.store.listCandidateSlots(requestId, 'active')) {
      this.store.recordSchedulingResponse({ requestId, slackUserId: 'system', response: 'rejected', slotId: slot.id, text: reason }, timestamp);
    }
  }

  private async replanAfterIncompatibleAcceptances(request: SchedulingRequest, timestamp = nowIso()): Promise<void> {
    this.rejectActiveSlots(request.id, 'Participants selected different proposed slots', timestamp);
    this.store.addSchedulingMessage(request.id, 'system', 'Participants selected different slots, so I will suggest a new set of options.', timestamp);
    await this.planRequest(request, 'accepted-slots-incompatible', timestamp);
  }

  private async bookAcceptedSlot(request: SchedulingRequest, slot: SchedulingCandidateSlot, timestamp = nowIso()): Promise<void> {
    const current = this.store.getSchedulingRequest(request.id);
    if (!current || terminal(current.status)) return;
    const match = this.store.getMatch(request.matchId);
    if (!match) return;
    const profiles = await this.participantProfiles(match);
    if (profiles.some((profile) => !profile.inviteAddress)) {
      this.store.markSchedulingManual(request.id, 'Missing verified invite address', timestamp);
      await this.notifyParticipants(request.id, 'manual', null, `manual:${request.id}:missing-invite`, timestamp);
      return;
    }
    const available = await this.calendar.revalidateSlot({ requestId: request.id, slot, participants: profiles });
    if (!available) {
      await this.planRequest(request, 'accepted-slot-stale', timestamp);
      return;
    }
    let event;
    try {
      event = await this.calendar.createBotOwnedEvent({
        requestId: request.id,
        slot,
        participants: profiles,
        summary: '☕ Random Coffee',
        description: 'Random Coffee scheduled by Cafe bot.',
      });
    } catch (error) {
      const message = `Calendar event creation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error({ err: error, requestId: request.id, slotId: slot.id }, 'Calendar event creation failed after overlapping slot acceptance');
      if (this.config.calendarAgentFallbackMode === 'failed') {
        this.store.markSchedulingFailed(request.id, message, timestamp);
        await this.notifyParticipants(request.id, 'failed', null, `failed:${request.id}:event-create:${dedupeSuffix()}`, timestamp);
      } else {
        this.store.markSchedulingManual(request.id, message, timestamp, slot.id);
        await this.notifyParticipants(request.id, 'manual', slot.id, `manual:${request.id}:event-create:${dedupeSuffix()}`, timestamp);
      }
      return;
    }
    this.store.markSchedulingBooked(request.id, slot.id, event.providerEventId, event.providerEventUrl ?? null, timestamp);
    this.queueMeetingStartNotifications(request, match, slot, timestamp);
    await this.notifyParticipants(request.id, 'booked', slot.id, `booked:${request.id}:${slot.id}`, timestamp);
  }

  private queueMeetingStartNotifications(request: SchedulingRequest, match: MatchRecord, slot: SchedulingCandidateSlot, timestamp = nowIso()): void {
    for (const userId of [match.userA, match.userB]) {
      this.store.createSchedulingNotificationJob({
        type: 'starting',
        requestId: request.id,
        userId,
        slotId: slot.id,
        dedupeKey: `starting:${request.id}:${slot.id}:${userId}`,
        nextAttemptAt: slot.startsAt,
        createdAt: timestamp,
      });
    }
  }

  private async notifyParticipants(requestId: number, type: SchedulingNotificationType, slotId: string | null, dedupeKeyPrefix: string, timestamp = nowIso()): Promise<void> {
    const request = this.store.getSchedulingRequest(requestId);
    const match = request ? this.store.getMatch(request.matchId) : null;
    if (!request || !match) return;
    await this.environment.notifyParticipants({ request, match, type, slotId, dedupeKeyPrefix, nextAttemptAt: timestamp, createdAt: timestamp });
  }
}
