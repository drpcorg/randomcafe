import type { MatchRecord, NotificationJob } from '../types.js';

export function pairNotificationBlocks(match: MatchRecord, recipientUserId: string): unknown[] {
  const partnerId = match.userA === recipientUserId ? match.userB : match.userA;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `☕ *Random Coffee*\nYou are paired with <@${partnerId}> for this cycle. Reach out and find a time for coffee!`,
      },
    },
  ];
}

export function reminderBlocks(match: MatchRecord): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `☕ *Random Coffee reminder*\nDid you and <@${match.userA}> / <@${match.userB}> meet?`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Met' },
          style: 'primary',
          action_id: 'feedback_met',
          value: String(match.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '⏳ Not yet' },
          action_id: 'feedback_not_yet',
          value: String(match.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Cannot meet' },
          style: 'danger',
          action_id: 'feedback_cannot_meet',
          value: String(match.id),
        },
      ],
    },
  ];
}

export function feedbackRecordedBlocks(text: string): unknown[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
  ];
}

export function messageTextForJob(job: NotificationJob, match: MatchRecord): string {
  if (job.type === 'pair_notification') {
    const partnerId = match.userA === job.userId ? match.userB : match.userA;
    return `Random Coffee: you are paired with <@${partnerId}>.`;
  }
  return `Random Coffee reminder for <@${match.userA}> and <@${match.userB}>.`;
}
