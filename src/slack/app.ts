import { App } from '@slack/bolt';
import type { Logger } from 'pino';
import { isAdmin } from '../config.js';
import type { CafeRepository } from '../db.js';
import { recordFeedbackAndUpdateMatch } from '../feedback.js';
import type { RuntimeConfig } from '../types.js';
import type { SchedulingCoordinator } from '../scheduling.js';
import { feedbackRecordedBlocks } from './messages.js';
import {
  ACTION_ADMIN_OPEN_CONFIG,
  ACTION_OPT_IN,
  ACTION_OPT_OUT,
  buildAdminConfigModal,
  modalErrorResponse,
  parseAdminConfigView,
  publishHome,
  validateAdminConfig,
  VIEW_ADMIN_CONFIG,
} from './home.js';
import {
  ACTION_SCHEDULE_ACCEPT,
  ACTION_SCHEDULE_ALTERNATIVES,
  ACTION_SCHEDULE_MANUAL,
  ACTION_SCHEDULE_OPEN_PREFERENCE,
  ACTION_SCHEDULE_SLOT_CHOICES,
  parseSchedulingActionValue,
  parseSchedulingPreferenceView,
  schedulingPreferenceModal,
  VIEW_SCHEDULE_PREFERENCE,
} from './schedulingMessages.js';

function slackUserIdFromBody(body: any): string | undefined {
  return body?.user?.id ?? body?.user_id;
}

function selectedSchedulingSlotIdsFromState(body: any, requestId: number): string[] {
  const values = body?.state?.values ?? {};
  const slotIds: string[] = [];
  for (const block of Object.values(values) as any[]) {
    for (const action of Object.values(block ?? {}) as any[]) {
      if (action?.type !== 'checkboxes' || action?.action_id !== ACTION_SCHEDULE_SLOT_CHOICES) continue;
      for (const option of action.selected_options ?? []) {
        const parsed = parseSchedulingActionValue(option.value);
        if (parsed?.requestId === requestId && parsed.slotId) slotIds.push(parsed.slotId);
      }
    }
  }
  return [...new Set(slotIds)];
}

export function createSlackApp(repository: CafeRepository, runtimeConfig: RuntimeConfig, logger: Logger, schedulingCoordinator?: SchedulingCoordinator): App {
  const app = new App({
    token: runtimeConfig.slackBotToken,
    appToken: runtimeConfig.slackAppToken,
    socketMode: true,
  });

  app.event('app_home_opened', async ({ event, client }: any) => {
    await publishHome(client, repository, runtimeConfig, event.user);
  });

  app.action(ACTION_OPT_OUT, async ({ ack, body, client }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    if (!userId) return;
    repository.setOptOut(userId, true);
    await publishHome(client, repository, runtimeConfig, userId);
  });

  app.action(ACTION_OPT_IN, async ({ ack, body, client }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    if (!userId) return;
    repository.setOptOut(userId, false);
    await publishHome(client, repository, runtimeConfig, userId);
  });


  app.action(ACTION_ADMIN_OPEN_CONFIG, async ({ ack, body, client }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    if (!userId || !isAdmin(runtimeConfig, userId)) {
      logger.warn({ userId }, 'Non-admin attempted to open coffee configuration');
      return;
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildAdminConfigModal(repository.getConfig()),
    });
  });

  app.view(VIEW_ADMIN_CONFIG, async ({ ack, body, view, client }: any) => {
    const userId = slackUserIdFromBody(body);
    if (!userId || !isAdmin(runtimeConfig, userId)) {
      await ack(modalErrorResponse('Only configured admins can change Random Coffee settings.'));
      logger.warn({ userId }, 'Non-admin attempted to submit coffee configuration');
      return;
    }

    const nextConfig = parseAdminConfigView(view, runtimeConfig, repository.getConfig());
    const errors = await validateAdminConfig(client, nextConfig);
    if (errors.length > 0) {
      await ack(modalErrorResponse(errors.join('\n')));
      return;
    }

    repository.saveConfig(nextConfig);
    await ack();
    await publishHome(client, repository, runtimeConfig, userId);
  });

  app.action(ACTION_SCHEDULE_SLOT_CHOICES, async ({ ack }: any) => {
    await ack();
  });

  app.action(ACTION_SCHEDULE_ACCEPT, async ({ ack, body, action, respond }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    const value = parseSchedulingActionValue(action.value);
    if (!userId || !value || !schedulingCoordinator) return;
    const slotIds = selectedSchedulingSlotIdsFromState(body, value.requestId);
    if (slotIds.length === 0) {
      if (respond) await respond({ replace_original: false, text: 'Please select at least one proposed slot first.' });
      return;
    }
    await schedulingCoordinator.handleParticipantResponse({ requestId: value.requestId, slotIds, userId, response: 'accepted' });
    if (respond) await respond({ replace_original: false, text: `✅ Noted: ${slotIds.length} option(s) work for you. I will book if your coffee partner selected any of the same slots.` });
  });

  app.action(ACTION_SCHEDULE_ALTERNATIVES, async ({ ack, body, action, respond }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    const value = parseSchedulingActionValue(action.value);
    if (!userId || !value || !schedulingCoordinator) return;
    await schedulingCoordinator.handleParticipantResponse({ requestId: value.requestId, slotId: value.slotId, userId, response: 'alternatives' });
    if (respond) await respond({ replace_original: false, text: '🔁 I will look for other options.' });
  });

  app.action(ACTION_SCHEDULE_MANUAL, async ({ ack, body, action, respond }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    const value = parseSchedulingActionValue(action.value);
    if (!userId || !value || !schedulingCoordinator) return;
    await schedulingCoordinator.handleParticipantResponse({ requestId: value.requestId, slotId: value.slotId, userId, response: 'manual' });
    if (respond) await respond({ replace_original: true, text: '🤝 Manual mode enabled. Please arrange directly; reminders will continue.' });
  });

  app.action(ACTION_SCHEDULE_OPEN_PREFERENCE, async ({ ack, body, action, client }: any) => {
    await ack();
    const value = parseSchedulingActionValue(action.value);
    if (!value) return;
    await client.views.open({ trigger_id: body.trigger_id, view: schedulingPreferenceModal(value.requestId, value.slotId) });
  });

  app.view(VIEW_SCHEDULE_PREFERENCE, async ({ ack, body, view }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    const parsed = parseSchedulingPreferenceView(view);
    if (!userId || !parsed || !schedulingCoordinator) return;
    await schedulingCoordinator.handleParticipantResponse({ requestId: parsed.requestId, slotId: parsed.slotId, userId, response: 'text_preference', text: parsed.text });
  });

  app.action('feedback_met', async ({ ack, body, action, respond }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    const matchId = Number(action.value);
    if (!userId || !Number.isInteger(matchId)) return;
    const result = recordFeedbackAndUpdateMatch(repository, matchId, userId, 'met');
    if (respond) await respond({ replace_original: true, text: result.text, blocks: feedbackRecordedBlocks(result.text) });
  });

  app.action('feedback_cannot_meet', async ({ ack, body, action, respond }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    const matchId = Number(action.value);
    if (!userId || !Number.isInteger(matchId)) return;
    const result = recordFeedbackAndUpdateMatch(repository, matchId, userId, 'cannot_meet');
    if (respond) await respond({ replace_original: true, text: result.text, blocks: feedbackRecordedBlocks(result.text) });
  });

  app.action('feedback_not_yet', async ({ ack, body, action, respond }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    const matchId = Number(action.value);
    if (!userId || !Number.isInteger(matchId)) return;
    const result = recordFeedbackAndUpdateMatch(repository, matchId, userId, 'not_yet');
    if (respond) await respond({ replace_original: false, text: result.text, blocks: feedbackRecordedBlocks(result.text) });
  });

  app.error(async (error: Error) => {
    logger.error({ err: error }, 'Slack app error');
  });

  return app;
}
