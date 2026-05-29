import type { Logger } from 'pino';
import type { CafeRepository } from './db.js';
import { processDueCycles, type CycleProcessorClient } from './cycles.js';
import type { SchedulingCoordinator } from './scheduling.js';
import { processDueReminderRows, processNotificationJobs, type SlackMessageClientLike } from './slack/notifications.js';
import { processSchedulingNotificationJobs } from './slack/schedulingNotifications.js';

export type SchedulerClient = CycleProcessorClient & SlackMessageClientLike;

export class CafeScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly client: SchedulerClient,
    private readonly repository: CafeRepository,
    private readonly logger: Logger,
    private readonly intervalMs: number,
    private readonly schedulingCoordinator?: SchedulingCoordinator,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error({ err: error }, 'Scheduler tick failed'));
    }, this.intervalMs);
    this.timer.unref();
    this.tick().catch((error) => this.logger.error({ err: error }, 'Initial scheduler tick failed'));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(timestamp = new Date().toISOString()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cycleResult = await processDueCycles(this.client, this.repository, this.logger, timestamp, this.schedulingCoordinator);
      const schedulingRequestsProcessed = this.schedulingCoordinator ? await this.schedulingCoordinator.processPendingRequests(timestamp) : 0;
      const schedulingExpired = this.schedulingCoordinator ? this.schedulingCoordinator.expireSchedulingForClosedMatches(timestamp) : 0;
      const remindersEnqueued = await processDueReminderRows(this.repository, timestamp);
      const notificationsSent = await processNotificationJobs(this.client, this.repository, this.logger, timestamp);
      const schedulingNotificationsSent = this.schedulingCoordinator ? await processSchedulingNotificationJobs(this.client, this.repository, this.logger, timestamp) : 0;
      if (cycleResult.created || cycleResult.failed || schedulingRequestsProcessed || schedulingExpired || remindersEnqueued || notificationsSent || schedulingNotificationsSent) {
        this.logger.info({ cycleResult, schedulingRequestsProcessed, schedulingExpired, remindersEnqueued, notificationsSent, schedulingNotificationsSent }, 'Scheduler tick processed work');
      }
    } finally {
      this.running = false;
    }
  }
}
