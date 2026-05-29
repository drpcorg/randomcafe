import crypto from 'node:crypto';
import { google } from 'googleapis';
import type { Logger } from 'pino';
import type { CafeRepository } from '../db.js';
import type { RuntimeConfig, SchedulingCandidateSlot } from '../types.js';
import { generateSharedSlots, RepositoryBackedCalendarService, type BusyInterval, type CreateCalendarEventInput, type CreatedCalendarEvent, type FindCalendarSlotsInput, type RevalidateSlotInput } from './service.js';

function googleEventId(requestId: number, slotId: string): string {
  return `cafe${crypto.createHash('sha256').update(`${requestId}:${slotId}`).digest('hex').slice(0, 24)}`;
}

export class GoogleCalendarService extends RepositoryBackedCalendarService {
  private readonly calendar;

  constructor(repository: CafeRepository, config: RuntimeConfig, logger?: Logger) {
    super(repository, config, logger);
    if (!config.calendarGoogleCredentialsJson) throw new Error('Google Calendar credentials are required when CALENDAR_PROVIDER=google');
    if (!config.calendarBotCalendarId) throw new Error('CALENDAR_BOT_CALENDAR_ID is required when CALENDAR_PROVIDER=google');
    const credentials = JSON.parse(config.calendarGoogleCredentialsJson) as { client_email?: string; private_key?: string };
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      subject: config.calendarGoogleSubject,
      scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.freebusy'],
    });
    this.calendar = google.calendar({ version: 'v3', auth });
  }

  private async busyIntervals(input: FindCalendarSlotsInput): Promise<Map<string, BusyInterval[]>> {
    const config = this.repository.getConfig();
    const now = new Date(input.now ?? new Date().toISOString());
    const horizonDays = Math.max(...input.participants.map((participant) => participant.preference.searchHorizonDays));
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000).toISOString();
    const optedIn = input.participants.filter((participant) => participant.identity && participant.preference.automatedSchedulingEnabled);
    if (optedIn.length === 0) return new Map();

    const response = await this.calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: config?.timezone ?? input.timezone,
        items: optedIn.map((participant) => ({ id: participant.identity!.calendarId || participant.identity!.calendarEmail })),
      },
    });

    const calendars = response.data.calendars ?? {};
    const byUser = new Map<string, BusyInterval[]>();
    for (const participant of optedIn) {
      const key = participant.identity!.calendarId || participant.identity!.calendarEmail;
      const busy = calendars[key]?.busy ?? [];
      byUser.set(participant.slackUserId, busy.map((item) => ({ startsAt: item.start!, endsAt: item.end! })).filter((item) => item.startsAt && item.endsAt));
    }
    return byUser;
  }

  async findSharedSlots(input: FindCalendarSlotsInput): Promise<Array<Omit<SchedulingCandidateSlot, 'requestId' | 'createdAt' | 'status'>>> {
    const busyByUser = await this.busyIntervals(input);
    return generateSharedSlots({ ...input, busyByUser });
  }

  async revalidateSlot(input: RevalidateSlotInput): Promise<boolean> {
    const busyByUser = await this.busyIntervals({
      requestId: input.requestId,
      participants: input.participants,
      timezone: this.repository.getConfig()?.timezone ?? 'UTC',
      now: new Date(Date.parse(input.slot.startsAt) - 1).toISOString(),
    });
    const starts = Date.parse(input.slot.startsAt);
    const ends = Date.parse(input.slot.endsAt);
    for (const participant of input.participants) {
      if (!participant.identity || !participant.preference.automatedSchedulingEnabled) continue;
      for (const busy of busyByUser.get(participant.slackUserId) ?? []) {
        if (starts < Date.parse(busy.endsAt) && ends > Date.parse(busy.startsAt)) return false;
      }
    }
    return true;
  }

  async createBotOwnedEvent(input: CreateCalendarEventInput): Promise<CreatedCalendarEvent> {
    if (!this.config.calendarBotCalendarId) throw new Error('CALENDAR_BOT_CALENDAR_ID is required');
    const eventId = googleEventId(input.requestId, input.slot.id);
    const attendees = input.participants.map((participant) => participant.inviteAddress?.email).filter(Boolean).map((email) => ({ email: email! }));
    try {
      const response = await this.calendar.events.insert({
        calendarId: this.config.calendarBotCalendarId,
        requestBody: {
          id: eventId,
          summary: input.summary,
          description: input.description,
          start: { dateTime: input.slot.startsAt },
          end: { dateTime: input.slot.endsAt },
          attendees,
        },
      });
      return { providerEventId: response.data.id ?? eventId, providerEventUrl: response.data.htmlLink ?? null };
    } catch (error: any) {
      if (error?.code === 409) {
        const existing = await this.calendar.events.get({ calendarId: this.config.calendarBotCalendarId, eventId });
        return { providerEventId: existing.data.id ?? eventId, providerEventUrl: existing.data.htmlLink ?? null };
      }
      throw error;
    }
  }
}
