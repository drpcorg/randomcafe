import { App } from '@slack/bolt';
import type { Logger } from 'pino';
import { isAdmin } from '../config.js';
import { defaultSchedulingPreference, type CalendarService } from '../calendar/service.js';
import type { CafeRepository } from '../db.js';
import { recordFeedbackAndUpdateMatch } from '../feedback.js';
import type { RuntimeConfig } from '../types.js';
import type { SchedulingCoordinator } from '../scheduling.js';
import { feedbackRecordedBlocks } from './messages.js';
import {
  ACTION_ADMIN_OPEN_CONFIG,
  ACTION_OPT_IN,
  ACTION_OPT_OUT,
  ACTION_SCHEDULE_OPEN_SETTINGS,
  buildAdminConfigModal,
  buildSchedulingSettingsModal,
  modalErrorResponse,
  parseAdminConfigView,
  parseSchedulingSettingsView,
  publishHome,
  validateAdminConfig,
  VIEW_ADMIN_CONFIG,
  VIEW_SCHEDULE_SETTINGS,
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
import {
  processSchedulingNotificationJobs,
  schedulingAlternativesRequestedText,
  schedulingManualModeChosenText,
  schedulingSelectionSavedText,
  schedulingSuggestTimeRequestedText,
  updateSchedulingInteractionMessage,
} from './schedulingNotifications.js';

function slackUserIdFromBody(body: any): string | undefined {
  return body?.user?.id ?? body?.user_id;
}

function slackInteractionLogContext(body: any): Record<string, unknown> {
  const action = body?.actions?.[0];
  const actionTsSeconds = Number(action?.action_ts ?? body?.action_ts ?? 0);
  const actionAgeMs = Number.isFinite(actionTsSeconds) && actionTsSeconds > 0
    ? Math.round(Date.now() - actionTsSeconds * 1000)
    : undefined;
  return {
    payloadType: body?.type,
    actionId: action?.action_id,
    blockId: action?.block_id,
    actionTs: action?.action_ts ?? body?.action_ts,
    actionAgeMs,
    userId: slackUserIdFromBody(body),
    channelId: body?.channel?.id,
    messageTs: body?.message?.ts,
  };
}

async function ackSlackInteraction(logger: Logger, label: string, body: any, ack: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  logger.info(slackInteractionLogContext(body), `${label}: sending Slack ack`);
  try {
    await ack();
    logger.info({ ...slackInteractionLogContext(body), ackMs: Date.now() - startedAt }, `${label}: Slack ack sent`);
  } catch (error) {
    logger.error({ err: error, ...slackInteractionLogContext(body), ackMs: Date.now() - startedAt }, `${label}: Slack ack failed`);
    throw error;
  }
}

function runAfterAck(logger: Logger, label: string, fn: () => Promise<void>): void {
  // Give Bolt/Socket Mode a short turn to flush ack to Slack before any
  // calendar/Pi work starts. This avoids Slack showing "trouble connecting"
  // even though the background work eventually succeeds.
  setTimeout(() => {
    fn().catch((error) => logger.error({ err: error }, `${label} failed after ack`));
  }, 100).unref();
}

function selectedSchedulingSlotIdsFromState(body: any, requestId: number): string[] {
  const values = body?.state?.values ?? {};
  const slotIds: string[] = [];
  for (const [blockId, block] of Object.entries(values) as Array<[string, Record<string, any>]>) {
    if (blockId !== `schedule_slot_choices:${requestId}`) continue;
    for (const [actionId, action] of Object.entries(block ?? {}) as Array<[string, any]>) {
      if (action?.type !== 'checkboxes') continue;
      if (actionId !== ACTION_SCHEDULE_SLOT_CHOICES && action?.action_id && action.action_id !== ACTION_SCHEDULE_SLOT_CHOICES) continue;
      for (const option of action.selected_options ?? []) {
        const parsed = parseSchedulingActionValue(option.value);
        if (parsed?.requestId === requestId && parsed.slotId) slotIds.push(parsed.slotId);
      }
    }
  }
  return [...new Set(slotIds)];
}

async function deliverQueuedSchedulingUpdates(client: any, repository: CafeRepository, logger: Logger): Promise<void> {
  await processSchedulingNotificationJobs(client, repository, logger, new Date().toISOString());
}

export function createSlackApp(repository: CafeRepository, runtimeConfig: RuntimeConfig, logger: Logger, schedulingCoordinator?: SchedulingCoordinator, calendarService?: CalendarService): App {
  const selectedSlotsByUserAndRequest = new Map<string, string[]>();
  const processedInteractionKeys = new Map<string, number>();
  const selectionKey = (requestId: number, userId: string) => `${requestId}:${userId}`;
  const rememberSelectedSlots = (requestId: number, userId: string, slotIds: string[]) => {
    const key = selectionKey(requestId, userId);
    if (slotIds.length === 0) selectedSlotsByUserAndRequest.delete(key);
    else selectedSlotsByUserAndRequest.set(key, [...new Set(slotIds)]);
  };
  const claimInteraction = (key: string, ttlMs = 5 * 60 * 1000): boolean => {
    const now = Date.now();
    for (const [existingKey, expiresAt] of processedInteractionKeys) {
      if (expiresAt <= now) processedInteractionKeys.delete(existingKey);
    }
    if (processedInteractionKeys.has(key)) return false;
    processedInteractionKeys.set(key, now + ttlMs);
    return true;
  };
  const releaseInteraction = (key: string): void => {
    processedInteractionKeys.delete(key);
  };

  const app = new App({
    token: runtimeConfig.slackBotToken,
    appToken: runtimeConfig.slackAppToken,
    socketMode: true,
  });

  const socketModeClient = (app as any).receiver?.client;
  if (socketModeClient?.on) {
    socketModeClient.on('slack_event', (event: any) => {
      const body = event?.body;
      if (body?.type !== 'block_actions' && body?.type !== 'view_submission') return;
      logger.info({
        envelopeId: event?.envelope_id,
        retryNum: event?.retry_num,
        retryReason: event?.retry_reason,
        ...slackInteractionLogContext(body),
      }, 'Received Slack interaction envelope');
    });
    socketModeClient.on('outgoing_message', (message: any) => {
      logger.info({
        envelopeId: message?.envelope_id,
        payloadKeys: Object.keys(message?.payload ?? {}),
      }, 'Sent Slack Socket Mode ack envelope');
    });
  }

  app.event('app_home_opened', async ({ event, client }: any) => {
    await publishHome(client, repository, runtimeConfig, event.user, calendarService);
  });

  app.action(ACTION_OPT_OUT, async ({ ack, body, client }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    if (!userId) return;
    repository.setOptOut(userId, true);
    await publishHome(client, repository, runtimeConfig, userId, calendarService);
  });

  app.action(ACTION_OPT_IN, async ({ ack, body, client }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    if (!userId) return;
    repository.setOptOut(userId, false);
    await publishHome(client, repository, runtimeConfig, userId, calendarService);
  });

  app.action(ACTION_SCHEDULE_OPEN_SETTINGS, async ({ ack, body, client }: any) => {
    await ack();
    const userId = slackUserIdFromBody(body);
    if (!userId || !runtimeConfig.calendarSchedulingEnabled) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildSchedulingSettingsModal(repository.getSchedulingPreference(userId) ?? defaultSchedulingPreference(userId, runtimeConfig)),
    });
  });

  app.view(VIEW_SCHEDULE_SETTINGS, async ({ ack, body, view, client }: any) => {
    const userId = slackUserIdFromBody(body);
    if (!userId || !runtimeConfig.calendarSchedulingEnabled) {
      await ack();
      return;
    }
    const parsed = parseSchedulingSettingsView(view, runtimeConfig, userId, repository.getSchedulingPreference(userId));
    if (parsed.errors) {
      await ack({ response_action: 'errors', errors: parsed.errors });
      return;
    }
    repository.saveSchedulingPreference(parsed.preference!);
    await ack();
    await publishHome(client, repository, runtimeConfig, userId, calendarService);
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
    await publishHome(client, repository, runtimeConfig, userId, calendarService);
  });

  app.action(ACTION_SCHEDULE_SLOT_CHOICES, async ({ ack, body, action }: any) => {
    await ackSlackInteraction(logger, 'scheduling slot checkbox interaction', body, ack);
    const userId = slackUserIdFromBody(body);
    if (!userId) return;
    const selectedOptions = action?.selected_options ?? [];
    const selectedSlotIds = selectedOptions
      .map((option: any) => parseSchedulingActionValue(option.value))
      .filter((value: any): value is { requestId: number; slotId?: string | null } => Boolean(value?.requestId && value.slotId));
    const requestId = selectedSlotIds[0]?.requestId ?? Number(String(action?.block_id ?? '').split(':')[1]);
    if (!Number.isInteger(requestId)) return;
    const slotIds = selectedSlotIds.map((value: { slotId?: string | null }) => value.slotId!);
    rememberSelectedSlots(requestId, userId, slotIds);
    logger.info({
      requestId,
      userId,
      slotCount: selectedSlotIds.length,
      slotIds,
      actionId: action?.action_id,
      blockId: action?.block_id,
      messageTs: body?.message?.ts,
      channelId: body?.channel?.id,
    }, 'Updated scheduling slot checkbox selection');
  });

  app.action(ACTION_SCHEDULE_ACCEPT, async ({ ack, body, action, respond, client }: any) => {
    await ackSlackInteraction(logger, 'scheduling accept interaction', body, ack);
    const userId = slackUserIdFromBody(body);
    const value = parseSchedulingActionValue(action.value);
    if (!userId || !value || !schedulingCoordinator) return;
    const slotIds = selectedSchedulingSlotIdsFromState(body, value.requestId);
    const rememberedSlotIds = selectedSlotsByUserAndRequest.get(selectionKey(value.requestId, userId)) ?? [];
    // Prefer the latest checkbox action we observed for this user/request.
    // Slack can include stale checkbox state in the subsequent button payload
    // when the user clicks Confirm immediately after changing selections.
    const chosenSlotIds = rememberedSlotIds.length > 0 ? rememberedSlotIds : slotIds;
    logger.info({
      requestId: value.requestId,
      userId,
      slotIdsFromState: slotIds,
      rememberedSlotIds,
      chosenSlotIds,
      stateBlockIds: Object.keys(body?.state?.values ?? {}),
      actionValue: action?.value,
      messageTs: body?.message?.ts,
      channelId: body?.channel?.id,
    }, 'Confirm selected scheduling slots clicked');
    if (chosenSlotIds.length === 0) {
      logger.warn({ requestId: value.requestId, userId, state: body?.state?.values, action: body?.actions?.[0] }, 'Confirm clicked without selected scheduling slots');
      if (respond) await respond({ replace_original: false, text: 'Please select at least one proposed slot first.' });
      return;
    }
    const interactionKey = `accept:${value.requestId}:${userId}:${body?.message?.ts ?? 'unknown'}`;
    if (!claimInteraction(interactionKey)) {
      logger.info({ requestId: value.requestId, userId, interactionKey }, 'Ignoring duplicate scheduling accept interaction');
      return;
    }

    try {
      await updateSchedulingInteractionMessage(client, body, schedulingSelectionSavedText(chosenSlotIds.length), respond);
    } catch (error) {
      logger.warn({ err: error, requestId: value.requestId, userId }, 'Could not update scheduling proposal message after selection');
    }

    runAfterAck(logger, 'scheduling accept interaction', async () => {
      try {
        await schedulingCoordinator.handleParticipantResponse({ requestId: value.requestId, slotIds: chosenSlotIds, userId, response: 'accepted' });
        rememberSelectedSlots(value.requestId, userId, []);
        await deliverQueuedSchedulingUpdates(client, repository, logger);
      } catch (error) {
        logger.error({ err: error, requestId: value.requestId, userId, chosenSlotIds }, 'Failed to handle selected scheduling slots');
        releaseInteraction(interactionKey);
        const errorText = `⚠️ *Selection saved locally, but I hit an error while processing it.*\n${error instanceof Error ? error.message : String(error)}`;
        try {
          await updateSchedulingInteractionMessage(client, body, errorText, respond);
        } catch {
          if (respond) await respond({ replace_original: false, text: errorText });
        }
      }
    });
  });

  app.action(ACTION_SCHEDULE_ALTERNATIVES, async ({ ack, body, action, client, respond }: any) => {
    await ackSlackInteraction(logger, 'scheduling alternatives interaction', body, ack);
    const userId = slackUserIdFromBody(body);
    const value = parseSchedulingActionValue(action.value);
    if (!userId || !value || !schedulingCoordinator) return;
    const interactionKey = `alternatives:${value.requestId}:${userId}:${body?.message?.ts ?? 'unknown'}`;
    if (!claimInteraction(interactionKey)) {
      logger.info({ requestId: value.requestId, userId, interactionKey }, 'Ignoring duplicate scheduling alternatives interaction');
      return;
    }
    rememberSelectedSlots(value.requestId, userId, []);
    await updateSchedulingInteractionMessage(client, body, schedulingAlternativesRequestedText, respond);
    runAfterAck(logger, 'scheduling alternatives interaction', async () => {
      try {
        await schedulingCoordinator.handleParticipantResponse({ requestId: value.requestId, slotId: value.slotId, userId, response: 'alternatives' });
        await deliverQueuedSchedulingUpdates(client, repository, logger);
      } catch (error) {
        releaseInteraction(interactionKey);
        throw error;
      }
    });
  });

  app.action(ACTION_SCHEDULE_MANUAL, async ({ ack, body, action, client, respond }: any) => {
    await ackSlackInteraction(logger, 'scheduling manual interaction', body, ack);
    const userId = slackUserIdFromBody(body);
    const value = parseSchedulingActionValue(action.value);
    if (!userId || !value || !schedulingCoordinator) return;
    const interactionKey = `manual:${value.requestId}:${userId}:${body?.message?.ts ?? 'unknown'}`;
    if (!claimInteraction(interactionKey)) {
      logger.info({ requestId: value.requestId, userId, interactionKey }, 'Ignoring duplicate scheduling manual interaction');
      return;
    }
    rememberSelectedSlots(value.requestId, userId, []);
    await updateSchedulingInteractionMessage(client, body, schedulingManualModeChosenText, respond);
    runAfterAck(logger, 'scheduling manual interaction', async () => {
      try {
        await schedulingCoordinator.handleParticipantResponse({ requestId: value.requestId, slotId: value.slotId, userId, response: 'manual' });
        await deliverQueuedSchedulingUpdates(client, repository, logger);
      } catch (error) {
        releaseInteraction(interactionKey);
        throw error;
      }
    });
  });

  app.action(ACTION_SCHEDULE_OPEN_PREFERENCE, async ({ ack, body, action, client, respond }: any) => {
    // Start the Socket Mode ACK before any parsing or Web API request.
    const ackPromise = ackSlackInteraction(logger, 'scheduling suggest-time interaction', body, ack);
    const value = parseSchedulingActionValue(action.value);
    if (!value) {
      await ackPromise;
      return;
    }
    const interactionKey = `suggest:${value.requestId}:${slackUserIdFromBody(body) ?? 'unknown'}:${body?.message?.ts ?? 'unknown'}`;
    if (!claimInteraction(interactionKey)) {
      await ackPromise;
      logger.info({ requestId: value.requestId, interactionKey }, 'Ignoring duplicate scheduling suggest-time interaction');
      return;
    }

    // `trigger_id` expires quickly, so open the modal immediately after the ACK
    // send has been initiated, but still wait for ACK before doing follow-up work.
    const openView = client.views.open({ trigger_id: body.trigger_id, view: schedulingPreferenceModal(value.requestId, value.slotId) });
    await ackPromise;
    runAfterAck(logger, 'scheduling suggest-time interaction', async () => {
      try {
        await openView;
      } catch (error) {
        releaseInteraction(interactionKey);
        logger.error({ err: error, requestId: value.requestId }, 'Could not open scheduling preference modal');
        throw error;
      }
      try {
        await updateSchedulingInteractionMessage(client, body, schedulingSuggestTimeRequestedText, respond);
      } catch (error) {
        logger.warn({ err: error, requestId: value.requestId }, 'Could not update scheduling proposal message after suggest-time action');
      }
    });
  });

  app.view(VIEW_SCHEDULE_PREFERENCE, async ({ ack, body, view, client }: any) => {
    await ack({ response_action: 'clear' });
    runAfterAck(logger, 'scheduling preference submission', async () => {
      const userId = slackUserIdFromBody(body);
      const parsed = parseSchedulingPreferenceView(view);
      if (!userId || !parsed || !schedulingCoordinator) return;
      const interactionKey = `preference:${parsed.requestId}:${userId}:${view?.id ?? view?.hash ?? parsed.text}`;
      if (!claimInteraction(interactionKey)) {
        logger.info({ requestId: parsed.requestId, userId, interactionKey }, 'Ignoring duplicate scheduling preference submission');
        return;
      }
      rememberSelectedSlots(parsed.requestId, userId, []);
      await schedulingCoordinator.handleParticipantResponse({ requestId: parsed.requestId, slotId: parsed.slotId, userId, response: 'text_preference', text: parsed.text });
      await deliverQueuedSchedulingUpdates(client, repository, logger);
    });
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
