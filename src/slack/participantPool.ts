import type { CafeRepository } from '../db.js';
import type { AppConfig, Participant, SlackUser } from '../types.js';

export interface SlackWebClientLike {
  conversations: {
    members(args: { channel: string; cursor?: string; limit?: number }): Promise<{ members?: string[]; response_metadata?: { next_cursor?: string } }>;
    info(args: { channel: string }): Promise<{ ok?: boolean }>;
  };
  users: {
    info(args: { user: string }): Promise<{ user?: { id?: string; name?: string; real_name?: string; tz?: string; tz_label?: string; tz_offset?: number; profile?: { email?: string }; is_bot?: boolean; deleted?: boolean } }>;
  };
}

export class ParticipantPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParticipantPoolError';
  }
}

export async function assertBotCanAccessChannel(client: SlackWebClientLike, channelId: string): Promise<void> {
  await client.conversations.info({ channel: channelId });
}

export async function fetchAllChannelMemberIds(client: SlackWebClientLike, channelId: string): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.conversations.members({ channel: channelId, cursor, limit: 200 });
    members.push(...(response.members ?? []));
    const nextCursor = response.response_metadata?.next_cursor?.trim();
    cursor = nextCursor && nextCursor.length > 0 ? nextCursor : undefined;
  } while (cursor);

  return members;
}

export async function fetchSlackUser(client: SlackWebClientLike, userId: string): Promise<SlackUser | null> {
  const response = await client.users.info({ user: userId });
  const user = response.user;
  if (!user?.id) return null;
  return {
    id: user.id,
    name: user.name,
    realName: user.real_name,
    email: user.profile?.email,
    timezone: user.tz,
    timezoneLabel: user.tz_label,
    timezoneOffset: user.tz_offset,
    isBot: user.is_bot,
    deleted: user.deleted,
  };
}

export function isEligibleSlackUser(user: SlackUser | null): user is SlackUser & { id: string } {
  return Boolean(user?.id && !user.deleted && !user.isBot);
}

export async function resolveParticipantPool(client: SlackWebClientLike, repository: CafeRepository, config: AppConfig): Promise<Participant[]> {
  await assertBotCanAccessChannel(client, config.coffeeChannelId);
  const memberIds = await fetchAllChannelMemberIds(client, config.coffeeChannelId);
  const optedOut = repository.getOptedOutUserIds();
  const participants: Participant[] = [];

  for (const memberId of memberIds) {
    if (optedOut.has(memberId)) continue;
    const user = await fetchSlackUser(client, memberId);
    if (!isEligibleSlackUser(user)) continue;
    participants.push({ slackUserId: user.id, displayName: user.realName || user.name || user.id });
  }

  if (participants.length > config.maxParticipants) {
    throw new ParticipantPoolError(`Eligible participant count ${participants.length} exceeds configured maximum ${config.maxParticipants}`);
  }

  return participants;
}
