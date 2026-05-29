import { DateTime } from 'luxon';
import type { AppConfig, CalendarIdentity, RuntimeConfig, SchedulingPreference } from '../types.js';
import type { CafeRepository } from '../db.js';
import { defaultSchedulingPreference, type BusyInterval, type CalendarService } from '../calendar/service.js';
import { isAdmin } from '../config.js';
import { validateScheduleInput } from '../schedule.js';
import { assertBotCanAccessChannel, fetchAllChannelMemberIds, fetchSlackUser, type SlackWebClientLike } from './participantPool.js';

export const ACTION_OPT_OUT = 'coffee_opt_out';
export const ACTION_OPT_IN = 'coffee_opt_in';
export const ACTION_ADMIN_OPEN_CONFIG = 'coffee_admin_open_config';
export const ACTION_SCHEDULE_OPEN_SETTINGS = 'schedule_home_open_settings';
export const VIEW_ADMIN_CONFIG = 'coffee_admin_config_submit';
export const VIEW_SCHEDULE_SETTINGS = 'schedule_home_settings_submit';

const BLOCK_CHANNEL = 'config_channel';
const BLOCK_FIRST = 'config_first_pairing';
const BLOCK_FREQUENCY = 'config_frequency';
const BLOCK_TIMEZONE = 'config_timezone';
const BLOCK_REMINDER = 'config_reminder_delay';
const BLOCK_SCHEDULE_AUTOMATED = 'schedule_automated';
const BLOCK_SCHEDULE_PREFERRED_START = 'schedule_preferred_start';
const BLOCK_SCHEDULE_PREFERRED_END = 'schedule_preferred_end';
const BLOCK_SCHEDULE_MIN_NOTICE = 'schedule_min_notice';
const BLOCK_SCHEDULE_WEEKDAYS = 'schedule_preferred_weekdays';

export interface SlackViewClientLike extends SlackWebClientLike {
  views: {
    publish(args: { user_id: string; view: unknown }): Promise<unknown>;
    open(args: { trigger_id: string; view: unknown }): Promise<unknown>;
  };
}

function googleCalendarShareTarget(runtimeConfig: RuntimeConfig): string {
  if (runtimeConfig.calendarProvider !== 'google') return '';
  try {
    const credentials = runtimeConfig.calendarGoogleCredentialsJson ? JSON.parse(runtimeConfig.calendarGoogleCredentialsJson) as { client_email?: string } : null;
    return credentials?.client_email?.trim() ?? '';
  } catch {
    return '';
  }
}

function calendarSharingInstructions(runtimeConfig: RuntimeConfig): string | null {
  if (runtimeConfig.calendarProvider !== 'google') return null;
  const shareTarget = googleCalendarShareTarget(runtimeConfig);
  const targetText = shareTarget ? `\`${shareTarget}\`` : 'the Cafe Google service account email from `client_email` in the bot credentials';
  return `*How to let Cafe read your busy times:*\n• If using calendar sharing: Google Calendar → your calendar → *Settings and sharing* → share with ${targetText} as *See only free/busy (hide details)*.\n• If using Workspace DWD: admin must authorize the service account for \`https://www.googleapis.com/auth/calendar.freebusy\`.`;
}

const weekdayOptions = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 7, label: 'Sun' },
];

function formatWeekdays(days: number[]): string {
  const selected = new Set(days);
  return weekdayOptions.filter((item) => selected.has(item.day)).map((item) => item.label).join(', ') || 'none';
}

function timeOfDayValid(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function minutesOf(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function looksLikeEmail(value: string | undefined): value is string {
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

function previewIdentityFromEmail(userId: string, email: string): CalendarIdentity {
  const now = new Date().toISOString();
  return {
    slackUserId: userId,
    provider: 'google',
    calendarEmail: email,
    calendarId: '',
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function weekStartDates(timezone: string, now = new Date()): DateTime[] {
  const start = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  return Array.from({ length: 7 }, (_, index) => start.plus({ days: index }));
}

function dayLabel(day: DateTime): string {
  return day.toFormat('ccc dd LLL');
}

function formatFirstRound(firstPairingLocal: string, configTimezone: string, userTimezone: string): string {
  const parsed = DateTime.fromISO(firstPairingLocal, { zone: configTimezone });
  if (!parsed.isValid) return `${firstPairingLocal} (${configTimezone})`;
  return `${parsed.setZone(userTimezone).toFormat('ccc, dd LLL yyyy HH:mm')} (${userTimezone})`;
}

function preferredAvailabilityFields(preference: SchedulingPreference, timezone: string): Array<{ type: 'mrkdwn'; text: string }> {
  const preferredDays = new Set(preference.preferredWeekdays);
  return weekStartDates(timezone).map((day) => ({
    type: 'mrkdwn' as const,
    text: `*${dayLabel(day)}*\n${preferredDays.has(day.weekday) ? `🟡 ${preference.preferredStart}–${preference.preferredEnd}` : '⚪ not preferred'}`,
  }));
}

function calendarBusyFields(intervals: BusyInterval[], preference: SchedulingPreference, timezone: string): Array<{ type: 'mrkdwn'; text: string }> {
  const byDate = new Map<string, string[]>();
  const preferredDays = new Set(preference.preferredWeekdays);
  for (const interval of intervals) {
    const starts = DateTime.fromISO(interval.startsAt, { zone: 'utc' }).setZone(timezone);
    const ends = DateTime.fromISO(interval.endsAt, { zone: 'utc' }).setZone(timezone);
    const dateKey = starts.toISODate();
    if (!dateKey) continue;
    const values = byDate.get(dateKey) ?? [];
    const timeText = starts.hasSame(ends, 'day')
      ? `${starts.toFormat('HH:mm')}–${ends.toFormat('HH:mm')}`
      : `${starts.toFormat('HH:mm')}–${ends.toFormat('ccc HH:mm')}`;
    values.push(timeText);
    byDate.set(dateKey, values);
  }
  return weekStartDates(timezone).map((day) => {
    const times = [...new Set(byDate.get(day.toISODate() ?? '') ?? [])].sort();
    const status = !preferredDays.has(day.weekday)
      ? '⛔ Blocked by your day preferences'
      : times.length > 0
        ? `🔴 ${times.join('\n🔴 ')}`
        : '⚪ No booked/busy slots';
    return {
      type: 'mrkdwn' as const,
      text: `*${dayLabel(day)}*\n${status}`,
    };
  });
}

async function availabilityPreviewBlocks(input: {
  calendarService?: CalendarService;
  preference: SchedulingPreference;
  identity: CalendarIdentity | null;
  profileEmail?: string;
  timezone: string;
  userId: string;
}): Promise<{ blocks: unknown[]; calendarAccessible: boolean }> {
  const { calendarService, preference, profileEmail, timezone, userId } = input;
  const identity = input.identity ?? (looksLikeEmail(profileEmail) ? previewIdentityFromEmail(userId, profileEmail) : null);
  if (!preference.automatedSchedulingEnabled) {
    return { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Your booked/busy slots this week*\nAutomated scheduling is off. Turn it on to let Cafe use your calendar.' } }], calendarAccessible: false };
  }

  if (!identity || !calendarService) {
    return {
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Your booked/busy slots this week*\nCalendar is not connected yet. Showing your preferred window, not Google free/busy.' }, fields: preferredAvailabilityFields(preference, timezone) }],
      calendarAccessible: false,
    };
  }

  try {
    const previewPreference = { ...preference, searchHorizonDays: Math.max(7, preference.searchHorizonDays) };
    const busyByUser = await calendarService.findBusyIntervals({
      participants: [{ slackUserId: userId, identity, inviteAddress: null, preference: previewPreference }],
      timezone,
      now: new Date().toISOString(),
      horizonDays: 7,
    });
    const busy = busyByUser.get(userId) ?? [];
    return {
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Your booked/busy slots this week*\nCalendar free/busy view. Showing every busy interval Cafe can see.' },
          fields: calendarBusyFields(busy, preference, timezone),
        },
      ],
      calendarAccessible: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Your booked/busy slots this week*\n⚠️ Could not read Google free/busy: ${message}\nShowing your preferred window instead.` }, fields: preferredAvailabilityFields(preference, timezone) }],
      calendarAccessible: false,
    };
  }
}

export async function buildHomeView(client: SlackWebClientLike, repository: CafeRepository, runtimeConfig: RuntimeConfig, userId: string, calendarService?: CalendarService): Promise<unknown> {
  const config = repository.getConfig();
  const optedOut = repository.isOptedOut(userId);
  const slackUser = await fetchSlackUser(client, userId).catch(() => null);
  const displayTimezone = slackUser?.timezone || config?.timezone || 'Europe/Berlin';
  let inChannel = false;
  if (config) {
    try {
      const members = await fetchAllChannelMemberIds(client, config.coffeeChannelId);
      inChannel = members.includes(userId);
    } catch {
      inChannel = false;
    }
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '☕ Random Coffee' },
    },
  ];

  if (!config) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'The coffee program is not configured yet.' } });
  } else {
    const status = !inChannel ? 'not in the coffee channel' : optedOut ? 'opted out' : 'participating';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Channel:* <#${config.coffeeChannelId}>\n*Status:* ${status}\n*First round:* ${formatFirstRound(config.firstPairingLocal, config.timezone, displayTimezone)}\n*Frequency:* ${config.frequency}\n*Reminder delay:* ${config.reminderDelayDays} day(s)`,
      },
    });


    if (inChannel && !optedOut) {
      blocks.push({
        type: 'actions',
        elements: [{ type: 'button', action_id: ACTION_OPT_OUT, text: { type: 'plain_text', text: 'Opt out' }, style: 'danger' }],
      });
    } else if (inChannel && optedOut) {
      blocks.push({
        type: 'actions',
        elements: [{ type: 'button', action_id: ACTION_OPT_IN, text: { type: 'plain_text', text: 'Join matching again' }, style: 'primary' }],
      });
    } else {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Join the configured channel to participate in matching.' }] });
    }
  }

  if (runtimeConfig.calendarSchedulingEnabled) {
    blocks.push({ type: 'divider' });
    const preference = repository.getSchedulingPreference(userId) ?? defaultSchedulingPreference(userId, runtimeConfig);
    const identity = repository.getCalendarIdentity(userId);
    const invite = repository.getVerifiedInviteAddress(userId);
    const profileEmail = slackUser?.email ?? (slackUser ? 'not returned by Slack; reinstall app with users:read.email if needed' : 'not available');
    const effectiveCalendar = identity?.calendarId || identity?.calendarEmail || (slackUser?.email ? `${slackUser.email} (will be auto-provisioned before scheduling)` : 'not known yet');
    const effectiveInvite = invite?.email || (slackUser?.email ? `${slackUser.email} (will be auto-provisioned before scheduling)` : 'not verified');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Calendar scheduling — what Cafe sees*\n• *Slack profile email:* ${profileEmail}\n• *Availability calendar:* ${effectiveCalendar}\n• *Invite address:* ${effectiveInvite}\n• *Auto scheduling:* ${preference.automatedSchedulingEnabled ? 'on' : 'off'}\n• *Preferred time:* ${preference.preferredStart}–${preference.preferredEnd}\n• *Preferred days:* ${formatWeekdays(preference.preferredWeekdays)}\n• *Minimum notice:* ${preference.minNoticeHours} hour(s)\n• *Calendar data read:* free/busy intervals only`,
      },
    });
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', action_id: ACTION_SCHEDULE_OPEN_SETTINGS, text: { type: 'plain_text', text: 'Edit scheduling preferences' }, style: 'primary' }],
    });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Times shown in your Slack timezone: *${displayTimezone}*` }] });
    const availabilityPreview = await availabilityPreviewBlocks({ calendarService, preference, identity, profileEmail: slackUser?.email, timezone: displayTimezone, userId });
    blocks.push(...availabilityPreview.blocks);
    const sharingInstructions = calendarSharingInstructions(runtimeConfig);
    if (sharingInstructions && !availabilityPreview.calendarAccessible) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: sharingInstructions },
      });
    }
  }

  if (isAdmin(runtimeConfig, userId)) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Admin settings*' } });
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', action_id: ACTION_ADMIN_OPEN_CONFIG, text: { type: 'plain_text', text: config ? 'Edit schedule' : 'Configure coffee' }, style: 'primary' }],
    });
  }

  return { type: 'home', blocks };
}

export async function publishHome(client: SlackViewClientLike, repository: CafeRepository, runtimeConfig: RuntimeConfig, userId: string, calendarService?: CalendarService): Promise<void> {
  const view = await buildHomeView(client, repository, runtimeConfig, userId, calendarService);
  await client.views.publish({ user_id: userId, view });
}

export function buildAdminConfigModal(current: AppConfig | null): unknown {
  return {
    type: 'modal',
    callback_id: VIEW_ADMIN_CONFIG,
    title: { type: 'plain_text', text: 'Random Coffee' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: BLOCK_CHANNEL,
        label: { type: 'plain_text', text: 'Coffee channel' },
        element: {
          type: 'conversations_select',
          action_id: 'value',
          initial_conversation: current?.coffeeChannelId,
          default_to_current_conversation: false,
          filter: {
            include: ['public', 'private'],
            exclude_bot_users: true,
          },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_FIRST,
        label: { type: 'plain_text', text: 'First pairing local date/time' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          initial_value: current?.firstPairingLocal ?? '',
          placeholder: { type: 'plain_text', text: '2026-06-03T10:00' },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_FREQUENCY,
        label: { type: 'plain_text', text: 'Frequency' },
        element: {
          type: 'static_select',
          action_id: 'value',
          initial_option: current
            ? { text: { type: 'plain_text', text: current.frequency }, value: current.frequency }
            : undefined,
          options: [
            { text: { type: 'plain_text', text: 'weekly' }, value: 'weekly' },
            { text: { type: 'plain_text', text: 'biweekly' }, value: 'biweekly' },
          ],
        },
      },
      {
        type: 'input',
        block_id: BLOCK_TIMEZONE,
        label: { type: 'plain_text', text: 'Timezone' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          initial_value: current?.timezone ?? 'Europe/Berlin',
          placeholder: { type: 'plain_text', text: 'Europe/Berlin' },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_REMINDER,
        label: { type: 'plain_text', text: 'Reminder delay in days' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          initial_value: current ? String(current.reminderDelayDays) : '3',
        },
      },
    ],
  };
}

function weekdayOption(day: number) {
  const label = weekdayOptions.find((item) => item.day === day)?.label ?? String(day);
  return { text: { type: 'plain_text', text: label }, value: String(day) };
}

export function buildSchedulingSettingsModal(preference: SchedulingPreference): unknown {
  const selected = new Set(preference.preferredWeekdays);
  return {
    type: 'modal',
    callback_id: VIEW_SCHEDULE_SETTINGS,
    title: { type: 'plain_text', text: 'Scheduling' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: BLOCK_SCHEDULE_AUTOMATED,
        label: { type: 'plain_text', text: 'Automated scheduling' },
        element: {
          type: 'static_select',
          action_id: 'value',
          initial_option: { text: { type: 'plain_text', text: preference.automatedSchedulingEnabled ? 'On' : 'Off' }, value: preference.automatedSchedulingEnabled ? 'on' : 'off' },
          options: [
            { text: { type: 'plain_text', text: 'On' }, value: 'on' },
            { text: { type: 'plain_text', text: 'Off' }, value: 'off' },
          ],
        },
      },
      {
        type: 'input',
        block_id: BLOCK_SCHEDULE_PREFERRED_START,
        label: { type: 'plain_text', text: 'Preferred start time' },
        element: { type: 'plain_text_input', action_id: 'value', initial_value: preference.preferredStart, placeholder: { type: 'plain_text', text: '10:00' } },
      },
      {
        type: 'input',
        block_id: BLOCK_SCHEDULE_PREFERRED_END,
        label: { type: 'plain_text', text: 'Preferred end time' },
        element: { type: 'plain_text_input', action_id: 'value', initial_value: preference.preferredEnd, placeholder: { type: 'plain_text', text: '17:00' } },
      },
      {
        type: 'input',
        block_id: BLOCK_SCHEDULE_MIN_NOTICE,
        label: { type: 'plain_text', text: 'Minimum notice in hours' },
        element: { type: 'plain_text_input', action_id: 'value', initial_value: String(preference.minNoticeHours), placeholder: { type: 'plain_text', text: '0' } },
      },
      {
        type: 'input',
        block_id: BLOCK_SCHEDULE_WEEKDAYS,
        label: { type: 'plain_text', text: 'Preferred days' },
        element: {
          type: 'checkboxes',
          action_id: 'value',
          options: weekdayOptions.map((item) => weekdayOption(item.day)),
          initial_options: weekdayOptions.filter((item) => selected.has(item.day)).map((item) => weekdayOption(item.day)),
        },
      },
    ],
  };
}

export function parseSchedulingSettingsView(
  view: { state?: { values?: Record<string, Record<string, any>> } },
  runtimeConfig: RuntimeConfig,
  userId: string,
  current: SchedulingPreference | null,
): { preference?: SchedulingPreference; errors?: Record<string, string> } {
  const base = current ?? defaultSchedulingPreference(userId, runtimeConfig);
  const automated = String(valueAt(view, BLOCK_SCHEDULE_AUTOMATED)?.selected_option?.value ?? 'on') !== 'off';
  const preferredStart = String(valueAt(view, BLOCK_SCHEDULE_PREFERRED_START)?.value ?? '').trim();
  const preferredEnd = String(valueAt(view, BLOCK_SCHEDULE_PREFERRED_END)?.value ?? '').trim();
  const minNoticeHours = Number(String(valueAt(view, BLOCK_SCHEDULE_MIN_NOTICE)?.value ?? '').trim());
  const preferredWeekdays: number[] = (valueAt(view, BLOCK_SCHEDULE_WEEKDAYS)?.selected_options ?? []).map((option: any) => Number(option.value)).filter((day: number) => Number.isInteger(day) && day >= 1 && day <= 7);
  const errors: Record<string, string> = {};
  if (!timeOfDayValid(preferredStart)) errors[BLOCK_SCHEDULE_PREFERRED_START] = 'Use HH:mm, for example 10:00.';
  if (!timeOfDayValid(preferredEnd)) errors[BLOCK_SCHEDULE_PREFERRED_END] = 'Use HH:mm, for example 17:00.';
  if (timeOfDayValid(preferredStart) && timeOfDayValid(preferredEnd) && minutesOf(preferredStart) >= minutesOf(preferredEnd)) errors[BLOCK_SCHEDULE_PREFERRED_END] = 'End time must be later than start time.';
  if (!Number.isInteger(minNoticeHours) || minNoticeHours < 0) errors[BLOCK_SCHEDULE_MIN_NOTICE] = 'Use a whole number, for example 0 or 24.';
  if (preferredWeekdays.length === 0) errors[BLOCK_SCHEDULE_WEEKDAYS] = 'Select at least one day.';
  if (Object.keys(errors).length > 0) return { errors };
  return {
    preference: {
      ...base,
      slackUserId: userId,
      preferredStart,
      preferredEnd,
      minNoticeHours,
      preferredWeekdays: [...new Set(preferredWeekdays)],
      automatedSchedulingEnabled: automated,
      updatedAt: new Date().toISOString(),
    },
  };
}

function valueAt(view: { state?: { values?: Record<string, Record<string, any>> } }, blockId: string): any {
  const actions = view.state?.values?.[blockId];
  if (!actions) return undefined;
  return Object.values(actions)[0];
}

export function parseAdminConfigView(view: { state?: { values?: Record<string, Record<string, any>> } }, runtimeConfig: RuntimeConfig, current: AppConfig | null): Omit<AppConfig, 'updatedAt'> {
  const channelValue = valueAt(view, BLOCK_CHANNEL);
  const firstValue = valueAt(view, BLOCK_FIRST);
  const frequencyValue = valueAt(view, BLOCK_FREQUENCY);
  const timezoneValue = valueAt(view, BLOCK_TIMEZONE);
  const reminderValue = valueAt(view, BLOCK_REMINDER);

  const coffeeChannelId = String(channelValue?.selected_conversation ?? channelValue?.value ?? '').trim();
  const firstPairingLocal = String(firstValue?.value ?? '').trim();
  const frequency = String(frequencyValue?.selected_option?.value ?? '') as AppConfig['frequency'];
  const timezone = String(timezoneValue?.value ?? '').trim();
  const reminderDelayDays = Number(String(reminderValue?.value ?? '').trim());

  return {
    coffeeChannelId,
    firstPairingLocal,
    frequency,
    timezone,
    reminderDelayDays,
    maxParticipants: current?.maxParticipants ?? runtimeConfig.maxParticipants,
    matchCandidateAttempts: Math.max(200, current?.matchCandidateAttempts ?? runtimeConfig.matchCandidateAttempts),
    maxRemindersPerMatch: current?.maxRemindersPerMatch ?? runtimeConfig.maxRemindersPerMatch,
  };
}

export async function validateAdminConfig(client: SlackWebClientLike, config: Omit<AppConfig, 'updatedAt'>): Promise<string[]> {
  const errors = validateScheduleInput(config);
  if (errors.length === 0) {
    try {
      await assertBotCanAccessChannel(client, config.coffeeChannelId);
    } catch {
      errors.push('Bot cannot access the selected channel. Invite it to the channel and try again.');
    }
  }
  return errors;
}

export function modalErrorResponse(message: string): unknown {
  return {
    response_action: 'errors',
    errors: {
      [BLOCK_CHANNEL]: message,
    },
  };
}
