import type { AppConfig, RuntimeConfig } from '../types.js';
import type { CafeRepository } from '../db.js';
import { isAdmin } from '../config.js';
import { validateScheduleInput } from '../schedule.js';
import { assertBotCanAccessChannel, fetchAllChannelMemberIds, type SlackWebClientLike } from './participantPool.js';

export const ACTION_OPT_OUT = 'coffee_opt_out';
export const ACTION_OPT_IN = 'coffee_opt_in';
export const ACTION_ADMIN_OPEN_CONFIG = 'coffee_admin_open_config';
export const VIEW_ADMIN_CONFIG = 'coffee_admin_config_submit';

const BLOCK_CHANNEL = 'config_channel';
const BLOCK_FIRST = 'config_first_pairing';
const BLOCK_FREQUENCY = 'config_frequency';
const BLOCK_TIMEZONE = 'config_timezone';
const BLOCK_REMINDER = 'config_reminder_delay';

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
  return `*How to share your Google Calendar with Cafe:*\n1. Open Google Calendar → your calendar → *Settings and sharing*.\n2. Under *Share with specific people or groups*, add ${targetText}.\n3. Set permission to *See only free/busy (hide details)*.\n4. Repeat for every calendar that should block your availability, then tell an admin which calendar email/id you shared.`;
}

export async function buildHomeView(client: SlackWebClientLike, repository: CafeRepository, runtimeConfig: RuntimeConfig, userId: string): Promise<unknown> {
  const config = repository.getConfig();
  const optedOut = repository.isOptedOut(userId);
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
        text: `*Channel:* <#${config.coffeeChannelId}>\n*Status:* ${status}\n*First round:* ${config.firstPairingLocal} (${config.timezone})\n*Frequency:* ${config.frequency}\n*Reminder delay:* ${config.reminderDelayDays} day(s)`,
      },
    });

    if (runtimeConfig.calendarSchedulingEnabled) {
      const preference = repository.getSchedulingPreference(userId);
      const identity = repository.getCalendarIdentity(userId);
      const invite = repository.getVerifiedInviteAddress(userId);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Calendar scheduling:* ${identity ? 'calendar connected' : 'calendar not connected'}\n*Invite address:* ${invite ? invite.email : 'not verified'}\n*Auto scheduling:* ${preference?.automatedSchedulingEnabled === false ? 'off' : 'on/default'}`,
        },
      });
      const sharingInstructions = calendarSharingInstructions(runtimeConfig);
      if (sharingInstructions && !identity) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: sharingInstructions },
        });
      }
    }

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

export async function publishHome(client: SlackViewClientLike, repository: CafeRepository, runtimeConfig: RuntimeConfig, userId: string): Promise<void> {
  const view = await buildHomeView(client, repository, runtimeConfig, userId);
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
