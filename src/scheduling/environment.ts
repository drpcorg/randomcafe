import type { MatchRecord, SchedulingNotificationType, SchedulingRequest } from '../types.js';
import type { SchedulingStore } from './store.js';

export interface SchedulingNotificationEnvelope {
  request: SchedulingRequest;
  match: MatchRecord;
  type: SchedulingNotificationType;
  slotId: string | null;
  dedupeKeyPrefix: string;
  nextAttemptAt?: string;
  createdAt?: string;
}

export interface SchedulingEnvironment {
  notifyParticipants(envelope: SchedulingNotificationEnvelope): void | Promise<void>;
}

export class RepositorySchedulingEnvironment implements SchedulingEnvironment {
  constructor(private readonly store: SchedulingStore) {}

  notifyParticipants(envelope: SchedulingNotificationEnvelope): void {
    for (const userId of [envelope.match.userA, envelope.match.userB]) {
      this.store.createSchedulingNotificationJob({
        type: envelope.type,
        requestId: envelope.request.id,
        userId,
        slotId: envelope.slotId,
        dedupeKey: `${envelope.dedupeKeyPrefix}:${userId}`,
        nextAttemptAt: envelope.nextAttemptAt,
        createdAt: envelope.createdAt,
      });
    }
  }
}

export interface MockSchedulingNotification extends SchedulingNotificationEnvelope {
  userId: string;
}

export class MockSchedulingEnvironment implements SchedulingEnvironment {
  readonly notifications: MockSchedulingNotification[] = [];

  notifyParticipants(envelope: SchedulingNotificationEnvelope): void {
    for (const userId of [envelope.match.userA, envelope.match.userB]) {
      this.notifications.push({ ...envelope, userId });
    }
  }

  byType(type: SchedulingNotificationType): MockSchedulingNotification[] {
    return this.notifications.filter((notification) => notification.type === type);
  }

  clear(): void {
    this.notifications.length = 0;
  }
}
