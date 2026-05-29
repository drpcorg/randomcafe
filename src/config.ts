import 'dotenv/config';
import fs from 'node:fs';
import { z } from 'zod';
import type { Frequency, RuntimeConfig } from './types.js';

export const DEFAULT_PI_PROVIDER = 'deepseek';
export const DEFAULT_PI_MODEL = 'deepseek-v4-flash';

function boolEnv(value: string | undefined, fallback = false): boolean {
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function credentialsJsonFromEnv(parsed: { GOOGLE_CALENDAR_CREDENTIALS_JSON?: string; GOOGLE_CALENDAR_CREDENTIALS_PATH?: string }): string | undefined {
  const inline = parsed.GOOGLE_CALENDAR_CREDENTIALS_JSON?.trim();
  if (inline) return inline;
  const file = parsed.GOOGLE_CALENDAR_CREDENTIALS_PATH?.trim();
  if (!file) return undefined;
  return fs.readFileSync(file, 'utf8');
}

const timeOfDay = /^\d{2}:\d{2}$/;

const runtimeEnvSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),
  ADMIN_USER_IDS: z.string().min(1),
  DATABASE_PATH: z.string().default('./data/cafe.sqlite'),
  LOG_LEVEL: z.string().default('info'),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  SCHEDULING_PLANNING_CONCURRENCY: z.coerce.number().int().positive().default(4),
  MAX_PARTICIPANTS: z.coerce.number().int().positive().default(200),
  MATCH_CANDIDATE_ATTEMPTS: z.coerce.number().int().positive().default(200),
  MAX_REMINDERS_PER_MATCH: z.coerce.number().int().positive().default(2),
  CALENDAR_SCHEDULING_ENABLED: z.string().optional(),
  CALENDAR_PROVIDER: z.enum(['google', 'fake']).default('google'),
  GOOGLE_CALENDAR_CREDENTIALS_JSON: z.string().optional(),
  GOOGLE_CALENDAR_CREDENTIALS_PATH: z.string().optional(),
  GOOGLE_CALENDAR_SUBJECT: z.string().optional(),
  CALENDAR_BOT_CALENDAR_ID: z.string().optional(),
  CALENDAR_DEFAULT_DURATION_MINUTES: z.coerce.number().int().positive().default(30),
  CALENDAR_SEARCH_HORIZON_DAYS: z.coerce.number().int().positive().default(7),
  CALENDAR_MINIMUM_NOTICE_HOURS: z.coerce.number().int().nonnegative().default(0),
  CALENDAR_DEFAULT_PREFERRED_START: z.string().regex(timeOfDay).default('10:00'),
  CALENDAR_DEFAULT_PREFERRED_END: z.string().regex(timeOfDay).default('17:00'),
  CALENDAR_AGENT_FALLBACK_MODE: z.enum(['manual', 'failed']).default('manual'),
  PI_PROVIDER: z.string().default(DEFAULT_PI_PROVIDER),
  PI_MODEL: z.string().default(DEFAULT_PI_MODEL),
  PI_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = runtimeEnvSchema.parse(env);
  const adminUserIds = new Set(
    parsed.ADMIN_USER_IDS.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (adminUserIds.size === 0) {
    throw new Error('ADMIN_USER_IDS must contain at least one Slack user ID');
  }

  return {
    slackBotToken: parsed.SLACK_BOT_TOKEN,
    slackAppToken: parsed.SLACK_APP_TOKEN,
    adminUserIds,
    databasePath: parsed.DATABASE_PATH,
    logLevel: parsed.LOG_LEVEL,
    schedulerIntervalSeconds: parsed.SCHEDULER_INTERVAL_SECONDS,
    schedulingPlanningConcurrency: parsed.SCHEDULING_PLANNING_CONCURRENCY,
    maxParticipants: parsed.MAX_PARTICIPANTS,
    matchCandidateAttempts: Math.max(200, parsed.MATCH_CANDIDATE_ATTEMPTS),
    maxRemindersPerMatch: parsed.MAX_REMINDERS_PER_MATCH,
    calendarSchedulingEnabled: boolEnv(parsed.CALENDAR_SCHEDULING_ENABLED, false),
    calendarProvider: parsed.CALENDAR_PROVIDER,
    calendarGoogleCredentialsJson: credentialsJsonFromEnv(parsed),
    calendarGoogleSubject: parsed.GOOGLE_CALENDAR_SUBJECT || undefined,
    calendarBotCalendarId: parsed.CALENDAR_BOT_CALENDAR_ID || undefined,
    calendarDefaultDurationMinutes: parsed.CALENDAR_DEFAULT_DURATION_MINUTES,
    calendarSearchHorizonDays: parsed.CALENDAR_SEARCH_HORIZON_DAYS,
    calendarMinimumNoticeHours: parsed.CALENDAR_MINIMUM_NOTICE_HOURS,
    calendarDefaultPreferredStart: parsed.CALENDAR_DEFAULT_PREFERRED_START,
    calendarDefaultPreferredEnd: parsed.CALENDAR_DEFAULT_PREFERRED_END,
    calendarAgentFallbackMode: parsed.CALENDAR_AGENT_FALLBACK_MODE,
    piProvider: parsed.PI_PROVIDER,
    piModel: parsed.PI_MODEL,
    piAgentTimeoutMs: parsed.PI_AGENT_TIMEOUT_MS,
  };
}

export function isAdmin(config: RuntimeConfig, slackUserId: string): boolean {
  return config.adminUserIds.has(slackUserId);
}

export function frequencyIntervalDays(frequency: Frequency): number {
  return frequency === 'weekly' ? 7 : 14;
}
