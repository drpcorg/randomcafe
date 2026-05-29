import { loadRuntimeConfig } from './config.js';
import { CafeRepository, migrate, openDatabase } from './db.js';
import { FakeCalendarService, GoogleCalendarService, type CalendarService } from './calendar/index.js';
import { createLogger } from './logger.js';
import { CafeScheduler } from './scheduler.js';
import { SchedulingCoordinator } from './scheduling.js';
import { createSlackApp } from './slack/app.js';

const runtimeConfig = loadRuntimeConfig();
const logger = createLogger(runtimeConfig.logLevel);
const db = openDatabase(runtimeConfig.databasePath);
migrate(db);
const repository = new CafeRepository(db);

let calendarService: CalendarService | undefined;
let schedulingCoordinator: SchedulingCoordinator | undefined;
if (runtimeConfig.calendarSchedulingEnabled) {
  calendarService = runtimeConfig.calendarProvider === 'fake'
    ? new FakeCalendarService(repository, runtimeConfig)
    : new GoogleCalendarService(repository, runtimeConfig, logger);
  schedulingCoordinator = new SchedulingCoordinator(repository, runtimeConfig, calendarService, logger);
}

const app = createSlackApp(repository, runtimeConfig, logger, schedulingCoordinator, calendarService);
const scheduler = new CafeScheduler(app.client as any, repository, logger, runtimeConfig.schedulerIntervalSeconds * 1000, schedulingCoordinator);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down Random Coffee bot');
  scheduler.stop();
  await app.stop();
  db.close();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.start();
scheduler.start();
logger.info('Random Coffee bot started in Slack Socket Mode');
