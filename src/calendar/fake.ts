import type { CafeRepository } from '../db.js';
import type { RuntimeConfig, SchedulingCandidateSlot } from '../types.js';
import { generateSharedSlots, RepositoryBackedCalendarService, type BusyInterval, type CreateCalendarEventInput, type CreatedCalendarEvent, type FindCalendarBusyInput, type FindCalendarSlotsInput, type RevalidateSlotInput } from './service.js';

export class FakeCalendarService extends RepositoryBackedCalendarService {
  private readonly busyByUser = new Map<string, BusyInterval[]>();
  private readonly createdEvents = new Map<string, CreatedCalendarEvent>();

  constructor(repository: CafeRepository, config: RuntimeConfig) {
    super(repository, config);
  }

  setBusy(slackUserId: string, busy: BusyInterval[]): void {
    this.busyByUser.set(slackUserId, busy);
  }

  getCreatedEvent(idempotencyKey: string): CreatedCalendarEvent | undefined {
    return this.createdEvents.get(idempotencyKey);
  }

  async findSharedSlots(input: FindCalendarSlotsInput): Promise<Array<Omit<SchedulingCandidateSlot, 'requestId' | 'createdAt' | 'status'>>> {
    return generateSharedSlots({ ...input, busyByUser: this.busyByUser });
  }

  async findBusyIntervals(input: FindCalendarBusyInput): Promise<Map<string, BusyInterval[]>> {
    const startsAfter = Date.parse(input.now ?? new Date().toISOString());
    const horizonDays = input.horizonDays ?? Math.max(...input.participants.map((participant) => participant.preference.searchHorizonDays));
    const endsBefore = startsAfter + horizonDays * 24 * 60 * 60 * 1000;
    const result = new Map<string, BusyInterval[]>();
    for (const participant of input.participants) {
      const intervals = (this.busyByUser.get(participant.slackUserId) ?? [])
        .filter((item) => Date.parse(item.startsAt) < endsBefore && Date.parse(item.endsAt) > startsAfter)
        .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
      result.set(participant.slackUserId, intervals);
    }
    return result;
  }

  async revalidateSlot(input: RevalidateSlotInput): Promise<boolean> {
    const starts = Date.parse(input.slot.startsAt);
    const ends = Date.parse(input.slot.endsAt);
    for (const participant of input.participants) {
      if (!participant.identity || !participant.preference.automatedSchedulingEnabled) continue;
      for (const busy of this.busyByUser.get(participant.slackUserId) ?? []) {
        if (starts < Date.parse(busy.endsAt) && ends > Date.parse(busy.startsAt)) return false;
      }
    }
    return true;
  }

  async createBotOwnedEvent(input: CreateCalendarEventInput): Promise<CreatedCalendarEvent> {
    const idempotencyKey = `${input.requestId}:${input.slot.id}`;
    const existing = this.createdEvents.get(idempotencyKey);
    if (existing) return existing;
    const created = {
      providerEventId: `fake_${input.requestId}_${input.slot.id}`,
      providerEventUrl: `https://calendar.example/${input.requestId}/${input.slot.id}`,
    };
    this.createdEvents.set(idempotencyKey, created);
    return created;
  }
}
