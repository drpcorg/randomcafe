import { DateTime } from 'luxon';
import type { CafeRepository } from '../db.js';
import type { SchedulingCandidateSlot, SchedulingNotificationJob, SchedulingRequest } from '../types.js';

export const ACTION_SCHEDULE_ACCEPT = 'schedule_accept';
export const ACTION_SCHEDULE_SLOT_CHOICES = 'schedule_slot_choices';
export const ACTION_SCHEDULE_ALTERNATIVES = 'schedule_alternatives';
export const ACTION_SCHEDULE_MANUAL = 'schedule_manual';
export const ACTION_SCHEDULE_OPEN_PREFERENCE = 'schedule_open_preference';
export const VIEW_SCHEDULE_PREFERENCE = 'schedule_preference_submit';

export function schedulingActionValue(requestId: number, slotId?: string | null): string {
  return JSON.stringify({ requestId, slotId: slotId ?? null });
}

export function parseSchedulingActionValue(value: string): { requestId: number; slotId?: string | null } | null {
  try {
    const parsed = JSON.parse(value) as { requestId?: unknown; slotId?: unknown };
    const requestId = Number(parsed.requestId);
    if (!Number.isInteger(requestId)) return null;
    return { requestId, slotId: parsed.slotId == null ? null : String(parsed.slotId) };
  } catch {
    return null;
  }
}

export function formatSlot(slot: SchedulingCandidateSlot | null | undefined, timezone: string): string {
  if (!slot) return 'No slot selected';
  const starts = DateTime.fromISO(slot.startsAt, { zone: 'utc' }).setZone(timezone).toFormat('ccc, dd LLL HH:mm');
  const ends = DateTime.fromISO(slot.endsAt, { zone: 'utc' }).setZone(timezone).toFormat('HH:mm');
  return `${starts}–${ends} ${timezone}`;
}

function formatSlotButton(slot: SchedulingCandidateSlot, index: number, timezone: string): string {
  const starts = DateTime.fromISO(slot.startsAt, { zone: 'utc' }).setZone(timezone).toFormat('ccc HH:mm');
  return `✅ ${index + 1}. ${starts}`;
}

export function schedulingProposalBlocks(request: SchedulingRequest, slots: SchedulingCandidateSlot[], partnerUserId?: string | null, timezone = 'UTC', explanation?: string | null): unknown[] {
  const proposed = slots.slice(0, 3);
  const partnerText = partnerUserId ? `Your coffee match: <@${partnerUserId}>\n` : '';
  const explanationText = explanation?.trim() ? `_${explanation.trim()}_\n` : '';
  const slotText = proposed.length > 0
    ? proposed.map((candidate, index) => `${index + 1}. *${formatSlot(candidate, timezone)}*`).join('\n')
    : 'No slots are currently available.';
  const slotOptions = proposed.map((slot, index) => ({
    text: { type: 'plain_text', text: formatSlotButton(slot, index, timezone) },
    value: schedulingActionValue(request.id, slot.id),
  }));
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `☕ *Random Coffee scheduling*\n${partnerText}${explanationText}Times shown in your Slack timezone: *${timezone}*\nSelect every time that works for you (1–3 options):\n${slotText}` },
    },
    {
      type: 'input',
      block_id: `schedule_slot_choices:${request.id}`,
      label: { type: 'plain_text', text: 'Times that work for you' },
      optional: true,
      element: {
        type: 'checkboxes',
        action_id: ACTION_SCHEDULE_SLOT_CHOICES,
        options: slotOptions,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Confirm selected slots' },
          action_id: ACTION_SCHEDULE_ACCEPT,
          value: schedulingActionValue(request.id, null),
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '🔁 Other options' }, action_id: ACTION_SCHEDULE_ALTERNATIVES, value: schedulingActionValue(request.id, null) },
        { type: 'button', text: { type: 'plain_text', text: '✍️ Suggest time' }, action_id: ACTION_SCHEDULE_OPEN_PREFERENCE, value: schedulingActionValue(request.id, null) },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: "🤝 We'll arrange ourselves" }, action_id: ACTION_SCHEDULE_MANUAL, value: schedulingActionValue(request.id, null) },
      ],
    },
  ];
}

export function schedulingManualBlocks(request: SchedulingRequest, slot?: SchedulingCandidateSlot | null, partnerUserId?: string | null, timezone = 'UTC'): unknown[] {
  const partnerText = partnerUserId ? `Coffee match: <@${partnerUserId}>\n` : '';
  const slotText = slot ? `\n*Agreed time:* ${formatSlot(slot, timezone)}\nPlease create/forward a calendar event manually for this time.` : '';
  return [{ type: 'section', text: { type: 'mrkdwn', text: `☕ *Random Coffee manual mode*\n${partnerText}This pair will arrange the meeting directly in Slack. I could not create the Google Calendar event automatically.${slotText}` } }];
}

export function schedulingBookedBlocks(slot: SchedulingCandidateSlot | null, timezone = 'UTC', eventUrl?: string | null): unknown[] {
  const linkText = eventUrl ? `\n<${eventUrl}|Open calendar event>` : '';
  return [{ type: 'section', text: { type: 'mrkdwn', text: `☕ *Random Coffee booked*\nCalendar event created for *${formatSlot(slot, timezone)}*.${linkText}` } }];
}

export function schedulingFailedBlocks(text: string): unknown[] {
  return [{ type: 'section', text: { type: 'mrkdwn', text } }];
}

export function schedulingPreferenceModal(requestId: number, slotId?: string | null): unknown {
  return {
    type: 'modal',
    callback_id: VIEW_SCHEDULE_PREFERENCE,
    private_metadata: schedulingActionValue(requestId, slotId),
    title: { type: 'plain_text', text: 'Scheduling preference' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'preference_text',
        label: { type: 'plain_text', text: 'What works better?' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'e.g. next week after lunch, not Friday' },
        },
      },
    ],
  };
}

export function parseSchedulingPreferenceView(view: { private_metadata?: string; state?: { values?: Record<string, Record<string, any>> } }): { requestId: number; slotId?: string | null; text: string } | null {
  const meta = parseSchedulingActionValue(view.private_metadata ?? '');
  const actions = view.state?.values?.preference_text;
  const value = actions ? Object.values(actions)[0]?.value : '';
  if (!meta || !String(value ?? '').trim()) return null;
  return { ...meta, text: String(value).trim() };
}

export function textForSchedulingJob(job: SchedulingNotificationJob, repository: CafeRepository): string {
  const request = repository.getSchedulingRequest(job.requestId);
  if (!request) return 'Random Coffee scheduling update.';
  if (job.type === 'manual') return 'Random Coffee: this pair will arrange the meeting manually.';
  if (job.type === 'booked') return 'Random Coffee: calendar event created.';
  if (job.type === 'failed') return 'Random Coffee: automated scheduling is unavailable.';
  if (job.type === 'no_slots') return 'Random Coffee: I could not find a shared slot yet.';
  return 'Random Coffee: suggested meeting time.';
}
