import type { Logger } from 'pino';
import { defaultSchedulingPreference } from '../calendar/service.js';
import type { CafeRepository } from '../db.js';
import type { RuntimeConfig } from '../types.js';
import { mapWithConcurrency } from '../asyncQueue.js';

export interface SlackCalendarProvisioningClientLike {
  users?: {
    info(args: { user: string }): Promise<{ user?: { id?: string; profile?: { email?: string }; is_bot?: boolean; deleted?: boolean } }>;
  };
}

function userIdsForPendingScheduling(repository: CafeRepository): string[] {
  const userIds = new Set<string>();
  for (const request of repository.listSchedulingRequestsByStatus(['pending'], 100)) {
    const match = repository.getMatch(request.matchId);
    if (!match || match.outcome !== 'active') continue;
    userIds.add(match.userA);
    userIds.add(match.userB);
  }
  return [...userIds];
}

export async function provisionCalendarIdentitiesForPendingScheduling(
  client: SlackCalendarProvisioningClientLike,
  repository: CafeRepository,
  runtimeConfig: RuntimeConfig,
  logger: Logger,
  timestamp = new Date().toISOString(),
): Promise<number> {
  if (!runtimeConfig.calendarSchedulingEnabled || !client.users?.info) return 0;
  const userIds = userIdsForPendingScheduling(repository);
  let provisioned = 0;

  await mapWithConcurrency(userIds, runtimeConfig.schedulingPlanningConcurrency, async (slackUserId) => {
    try {
      const response = await client.users!.info({ user: slackUserId });
      const user = response.user;
      const email = user?.profile?.email?.trim();
      if (!user?.id || user.deleted || user.is_bot || !email) return;

      repository.transaction(() => {
        repository.saveVerifiedInviteAddress({ slackUserId, email, source: 'slack', verifiedAt: timestamp }, timestamp);
        if (!repository.getCalendarIdentity(slackUserId)) {
          repository.saveCalendarIdentity({ slackUserId, provider: runtimeConfig.calendarProvider, calendarEmail: email, calendarId: email, verifiedAt: timestamp }, timestamp);
        }
        if (!repository.getSchedulingPreference(slackUserId)) {
          repository.saveSchedulingPreference(defaultSchedulingPreference(slackUserId, runtimeConfig, timestamp), timestamp);
        }
      });
      provisioned += 1;
    } catch (error) {
      logger.warn({ err: error, slackUserId }, 'Failed to provision calendar identity from Slack profile');
    }
  });

  return provisioned;
}
