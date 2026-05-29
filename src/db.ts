import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  AppConfig,
  CalendarIdentity,
  CalendarProvider,
  CycleRecord,
  CycleStatus,
  FeedbackOutcome,
  FeedbackResponse,
  JobStatus,
  JobType,
  MatchOutcome,
  MatchPair,
  MatchRecord,
  NotificationJob,
  PairHistoryEntry,
  ReminderRecord,
  SchedulingCandidateSlot,
  SchedulingMessage,
  SchedulingMessageRole,
  SchedulingNotificationJob,
  SchedulingNotificationType,
  SchedulingPreference,
  SchedulingRequest,
  SchedulingResponse,
  SchedulingResponseType,
  SchedulingSlotStatus,
  SchedulingStatus,
  VerifiedInviteAddress,
} from './types.js';

export type SqliteDatabase = Database.Database;

export function nowIso(): string {
  return new Date().toISOString();
}

export function openDatabase(databasePath: string): SqliteDatabase {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

const migrations = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS app_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  coffee_channel_id TEXT NOT NULL,
  first_pairing_local TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'biweekly')),
  timezone TEXT NOT NULL,
  reminder_delay_days INTEGER NOT NULL CHECK (reminder_delay_days > 0),
  max_participants INTEGER NOT NULL CHECK (max_participants > 0),
  match_candidate_attempts INTEGER NOT NULL CHECK (match_candidate_attempts >= 200),
  max_reminders_per_match INTEGER NOT NULL CHECK (max_reminders_per_match > 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opt_outs (
  slack_user_id TEXT PRIMARY KEY,
  opted_out_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_at TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'failed')),
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'active' CHECK (outcome IN ('active', 'met', 'cancelled', 'expired')),
  reminder_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK (user_a < user_b),
  UNIQUE (cycle_id, user_a, user_b)
);

CREATE TABLE IF NOT EXISTS skipped_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  skipped_at TEXT NOT NULL,
  UNIQUE (cycle_id, slack_user_id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (match_id, sequence)
);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('pair_notification', 'reminder')),
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  reminder_id INTEGER REFERENCES reminders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  slack_channel_id TEXT,
  slack_ts TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  responder_user_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('met', 'not_yet', 'cannot_meet')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cycles_status ON cycles(status);
CREATE INDEX IF NOT EXISTS idx_matches_cycle ON matches(cycle_id);
CREATE INDEX IF NOT EXISTS idx_matches_outcome ON matches(outcome);
CREATE INDEX IF NOT EXISTS idx_skipped_user ON skipped_participants(slack_user_id, skipped_at);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON notification_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_feedback_match ON feedback_responses(match_id);
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS calendar_identities (
  slack_user_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  calendar_email TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verified_invite_addresses (
  slack_user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('calendar', 'slack', 'manual')),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduling_preferences (
  slack_user_id TEXT PRIMARY KEY,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  search_horizon_days INTEGER NOT NULL CHECK (search_horizon_days > 0),
  min_notice_hours INTEGER NOT NULL CHECK (min_notice_hours >= 0),
  preferred_start TEXT NOT NULL,
  preferred_end TEXT NOT NULL,
  automated_scheduling_enabled INTEGER NOT NULL CHECK (automated_scheduling_enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduling_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'proposed', 'manual', 'booked', 'failed', 'expired')),
  selected_slot_id TEXT,
  provider_event_id TEXT,
  provider_event_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduling_candidate_slots (
  id TEXT PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES scheduling_requests(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'booked')),
  score REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduling_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES scheduling_requests(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  response TEXT NOT NULL CHECK (response IN ('accepted', 'rejected', 'alternatives', 'text_preference', 'manual')),
  slot_id TEXT REFERENCES scheduling_candidate_slots(id) ON DELETE SET NULL,
  text TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduling_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES scheduling_requests(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduling_notification_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('proposal', 'manual', 'booked', 'failed', 'no_slots')),
  request_id INTEGER NOT NULL REFERENCES scheduling_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  slot_id TEXT REFERENCES scheduling_candidate_slots(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  slack_channel_id TEXT,
  slack_ts TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduling_requests_status ON scheduling_requests(status);
CREATE INDEX IF NOT EXISTS idx_scheduling_slots_request ON scheduling_candidate_slots(request_id, status);
CREATE INDEX IF NOT EXISTS idx_scheduling_responses_request ON scheduling_responses(request_id, slack_user_id);
CREATE INDEX IF NOT EXISTS idx_scheduling_notifications_due ON scheduling_notification_jobs(status, next_attempt_at);
`,
  },
];

export function migrate(db: SqliteDatabase): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`);

  const hasVersion = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const insertVersion = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  const apply = db.transaction(() => {
    for (const migration of migrations) {
      if (!hasVersion.get(migration.version)) {
        db.exec(migration.sql);
        insertVersion.run(migration.version, nowIso());
      }
    }
  });

  apply();
}

export function normalizePair(userA: string, userB: string): MatchPair {
  if (userA === userB) {
    throw new Error('Cannot create a match with the same user twice');
  }
  return userA < userB ? { userA, userB } : { userA: userB, userB: userA };
}

function mapConfig(row: Record<string, unknown>): AppConfig {
  return {
    coffeeChannelId: String(row.coffee_channel_id),
    firstPairingLocal: String(row.first_pairing_local),
    frequency: row.frequency as AppConfig['frequency'],
    timezone: String(row.timezone),
    reminderDelayDays: Number(row.reminder_delay_days),
    maxParticipants: Number(row.max_participants),
    matchCandidateAttempts: Number(row.match_candidate_attempts),
    maxRemindersPerMatch: Number(row.max_reminders_per_match),
    updatedAt: String(row.updated_at),
  };
}

function mapCycle(row: Record<string, unknown>): CycleRecord {
  return {
    id: Number(row.id),
    scheduledAt: String(row.scheduled_at),
    sequence: Number(row.sequence),
    status: row.status as CycleStatus,
    failureReason: row.failure_reason == null ? null : String(row.failure_reason),
    createdAt: String(row.created_at),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
  };
}

function mapMatch(row: Record<string, unknown>): MatchRecord {
  return {
    id: Number(row.id),
    cycleId: Number(row.cycle_id),
    userA: String(row.user_a),
    userB: String(row.user_b),
    outcome: row.outcome as MatchOutcome,
    reminderCount: Number(row.reminder_count),
    createdAt: String(row.created_at),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
  };
}

function mapReminder(row: Record<string, unknown>): ReminderRecord {
  return {
    id: Number(row.id),
    matchId: Number(row.match_id),
    sequence: Number(row.sequence),
    dueAt: String(row.due_at),
    status: row.status as JobStatus,
    sentAt: row.sent_at == null ? null : String(row.sent_at),
    createdAt: String(row.created_at),
  };
}

function mapJob(row: Record<string, unknown>): NotificationJob {
  return {
    id: Number(row.id),
    type: row.type as JobType,
    matchId: Number(row.match_id),
    userId: String(row.user_id),
    reminderId: row.reminder_id == null ? null : Number(row.reminder_id),
    status: row.status as JobStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: String(row.next_attempt_at),
    sentAt: row.sent_at == null ? null : String(row.sent_at),
    slackChannelId: row.slack_channel_id == null ? null : String(row.slack_channel_id),
    slackTs: row.slack_ts == null ? null : String(row.slack_ts),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
  };
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function mapCalendarIdentity(row: Record<string, unknown>): CalendarIdentity {
  return {
    slackUserId: String(row.slack_user_id),
    provider: String(row.provider) as CalendarProvider,
    calendarEmail: String(row.calendar_email),
    calendarId: String(row.calendar_id),
    verifiedAt: String(row.verified_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapInviteAddress(row: Record<string, unknown>): VerifiedInviteAddress {
  return {
    slackUserId: String(row.slack_user_id),
    email: String(row.email),
    source: row.source as VerifiedInviteAddress['source'],
    verifiedAt: String(row.verified_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPreference(row: Record<string, unknown>): SchedulingPreference {
  return {
    slackUserId: String(row.slack_user_id),
    durationMinutes: Number(row.duration_minutes),
    searchHorizonDays: Number(row.search_horizon_days),
    minNoticeHours: Number(row.min_notice_hours),
    preferredStart: String(row.preferred_start),
    preferredEnd: String(row.preferred_end),
    automatedSchedulingEnabled: Boolean(Number(row.automated_scheduling_enabled)),
    updatedAt: String(row.updated_at),
  };
}

function mapSchedulingRequest(row: Record<string, unknown>): SchedulingRequest {
  return {
    id: Number(row.id),
    matchId: Number(row.match_id),
    status: row.status as SchedulingStatus,
    selectedSlotId: row.selected_slot_id == null ? null : String(row.selected_slot_id),
    providerEventId: row.provider_event_id == null ? null : String(row.provider_event_id),
    providerEventUrl: row.provider_event_url == null ? null : String(row.provider_event_url),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapCandidateSlot(row: Record<string, unknown>): SchedulingCandidateSlot {
  return {
    id: String(row.id),
    requestId: Number(row.request_id),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    status: row.status as SchedulingSlotStatus,
    score: Number(row.score),
    reasons: parseJsonArray(row.reasons_json),
    createdAt: String(row.created_at),
  };
}

function mapSchedulingResponse(row: Record<string, unknown>): SchedulingResponse {
  return {
    id: Number(row.id),
    requestId: Number(row.request_id),
    slackUserId: String(row.slack_user_id),
    response: row.response as SchedulingResponseType,
    slotId: row.slot_id == null ? null : String(row.slot_id),
    text: row.text == null ? null : String(row.text),
    createdAt: String(row.created_at),
  };
}

function mapSchedulingMessage(row: Record<string, unknown>): SchedulingMessage {
  return {
    id: Number(row.id),
    requestId: Number(row.request_id),
    role: row.role as SchedulingMessageRole,
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}

function mapSchedulingNotification(row: Record<string, unknown>): SchedulingNotificationJob {
  return {
    id: Number(row.id),
    type: row.type as SchedulingNotificationType,
    requestId: Number(row.request_id),
    userId: String(row.user_id),
    slotId: row.slot_id == null ? null : String(row.slot_id),
    status: row.status as JobStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: String(row.next_attempt_at),
    sentAt: row.sent_at == null ? null : String(row.sent_at),
    slackChannelId: row.slack_channel_id == null ? null : String(row.slack_channel_id),
    slackTs: row.slack_ts == null ? null : String(row.slack_ts),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
  };
}

export class CafeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getConfig(): AppConfig | null {
    const row = this.db.prepare('SELECT * FROM app_config WHERE id = 1').get() as Record<string, unknown> | undefined;
    return row ? mapConfig(row) : null;
  }

  saveConfig(config: Omit<AppConfig, 'updatedAt'>, updatedAt = nowIso()): AppConfig {
    this.db
      .prepare(
        `INSERT INTO app_config (
          id, coffee_channel_id, first_pairing_local, frequency, timezone, reminder_delay_days,
          max_participants, match_candidate_attempts, max_reminders_per_match, updated_at
        ) VALUES (1, @coffeeChannelId, @firstPairingLocal, @frequency, @timezone, @reminderDelayDays,
          @maxParticipants, @matchCandidateAttempts, @maxRemindersPerMatch, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          coffee_channel_id = excluded.coffee_channel_id,
          first_pairing_local = excluded.first_pairing_local,
          frequency = excluded.frequency,
          timezone = excluded.timezone,
          reminder_delay_days = excluded.reminder_delay_days,
          max_participants = excluded.max_participants,
          match_candidate_attempts = excluded.match_candidate_attempts,
          max_reminders_per_match = excluded.max_reminders_per_match,
          updated_at = excluded.updated_at`,
      )
      .run({ ...config, updatedAt });
    const saved = this.getConfig();
    if (!saved) throw new Error('Failed to save app config');
    return saved;
  }

  setOptOut(slackUserId: string, optedOut: boolean, timestamp = nowIso()): void {
    if (optedOut) {
      this.db
        .prepare('INSERT INTO opt_outs (slack_user_id, opted_out_at) VALUES (?, ?) ON CONFLICT(slack_user_id) DO UPDATE SET opted_out_at = excluded.opted_out_at')
        .run(slackUserId, timestamp);
    } else {
      this.db.prepare('DELETE FROM opt_outs WHERE slack_user_id = ?').run(slackUserId);
    }
  }

  isOptedOut(slackUserId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM opt_outs WHERE slack_user_id = ?').get(slackUserId));
  }

  getOptedOutUserIds(): Set<string> {
    const rows = this.db.prepare('SELECT slack_user_id FROM opt_outs').all() as Array<{ slack_user_id: string }>;
    return new Set(rows.map((row) => row.slack_user_id));
  }

  getLastCycle(): CycleRecord | null {
    const row = this.db.prepare('SELECT * FROM cycles ORDER BY sequence DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    return row ? mapCycle(row) : null;
  }

  getCycleByScheduledAt(scheduledAt: string): CycleRecord | null {
    const row = this.db.prepare('SELECT * FROM cycles WHERE scheduled_at = ?').get(scheduledAt) as Record<string, unknown> | undefined;
    return row ? mapCycle(row) : null;
  }

  createCycle(scheduledAt: string, sequence: number, status: CycleStatus = 'open', failureReason: string | null = null, timestamp = nowIso()): CycleRecord {
    this.db
      .prepare('INSERT OR IGNORE INTO cycles (scheduled_at, sequence, status, failure_reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(scheduledAt, sequence, status, failureReason, timestamp);
    const cycle = this.getCycleByScheduledAt(scheduledAt);
    if (!cycle) throw new Error(`Failed to create cycle for ${scheduledAt}`);
    return cycle;
  }

  failCycle(cycleId: number, reason: string, timestamp = nowIso()): void {
    this.db.prepare('UPDATE cycles SET status = ?, failure_reason = ?, closed_at = ? WHERE id = ?').run('failed', reason, timestamp, cycleId);
  }

  closeCycle(cycleId: number, status: CycleStatus = 'completed', timestamp = nowIso()): void {
    this.db.prepare('UPDATE cycles SET status = ?, closed_at = ? WHERE id = ? AND closed_at IS NULL').run(status, timestamp, cycleId);
  }

  listOpenCyclesBefore(scheduledAt: string): CycleRecord[] {
    const rows = this.db.prepare('SELECT * FROM cycles WHERE status = ? AND scheduled_at < ? ORDER BY sequence ASC').all('open', scheduledAt) as Record<string, unknown>[];
    return rows.map(mapCycle);
  }

  expireActiveMatchesForCycle(cycleId: number, timestamp = nowIso()): number {
    const result = this.db
      .prepare('UPDATE matches SET outcome = ?, closed_at = ? WHERE cycle_id = ? AND outcome = ?')
      .run('expired', timestamp, cycleId, 'active');
    return Number(result.changes);
  }

  createMatch(cycleId: number, firstUser: string, secondUser: string, timestamp = nowIso()): MatchRecord {
    const { userA, userB } = normalizePair(firstUser, secondUser);
    const result = this.db
      .prepare('INSERT INTO matches (cycle_id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)')
      .run(cycleId, userA, userB, timestamp);
    return this.getMatch(Number(result.lastInsertRowid))!;
  }

  getMatch(matchId: number): MatchRecord | null {
    const row = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as Record<string, unknown> | undefined;
    return row ? mapMatch(row) : null;
  }

  listMatchesForCycle(cycleId: number): MatchRecord[] {
    const rows = this.db.prepare('SELECT * FROM matches WHERE cycle_id = ? ORDER BY id ASC').all(cycleId) as Record<string, unknown>[];
    return rows.map(mapMatch);
  }

  getCycleForMatch(matchId: number): CycleRecord | null {
    const row = this.db
      .prepare('SELECT c.* FROM cycles c INNER JOIN matches m ON m.cycle_id = c.id WHERE m.id = ?')
      .get(matchId) as Record<string, unknown> | undefined;
    return row ? mapCycle(row) : null;
  }

  updateMatchOutcome(matchId: number, outcome: MatchOutcome, timestamp = nowIso()): void {
    const closedAt = outcome === 'active' ? null : timestamp;
    this.db.prepare('UPDATE matches SET outcome = ?, closed_at = ? WHERE id = ?').run(outcome, closedAt, matchId);
  }

  incrementMatchReminderCount(matchId: number): void {
    this.db.prepare('UPDATE matches SET reminder_count = reminder_count + 1 WHERE id = ?').run(matchId);
  }

  recordSkippedParticipant(cycleId: number, slackUserId: string, timestamp = nowIso()): void {
    this.db
      .prepare('INSERT OR IGNORE INTO skipped_participants (cycle_id, slack_user_id, skipped_at) VALUES (?, ?, ?)')
      .run(cycleId, slackUserId, timestamp);
  }

  getSkipHistory(): Map<string, string> {
    const rows = this.db
      .prepare('SELECT slack_user_id, MAX(skipped_at) AS last_skipped_at FROM skipped_participants GROUP BY slack_user_id')
      .all() as Array<{ slack_user_id: string; last_skipped_at: string }>;
    return new Map(rows.map((row) => [row.slack_user_id, row.last_skipped_at]));
  }

  getPairHistory(beforeSequence: number): PairHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT m.user_a AS userA, m.user_b AS userB, MAX(c.sequence) AS lastSequence
         FROM matches m
         INNER JOIN cycles c ON c.id = m.cycle_id
         WHERE c.sequence < ?
         GROUP BY m.user_a, m.user_b`,
      )
      .all(beforeSequence) as PairHistoryEntry[];
    return rows.map((row) => ({ userA: row.userA, userB: row.userB, lastSequence: Number(row.lastSequence) }));
  }

  createReminder(matchId: number, sequence: number, dueAt: string, timestamp = nowIso()): ReminderRecord {
    this.db
      .prepare('INSERT OR IGNORE INTO reminders (match_id, sequence, due_at, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(matchId, sequence, dueAt, 'pending', timestamp);
    const row = this.db.prepare('SELECT * FROM reminders WHERE match_id = ? AND sequence = ?').get(matchId, sequence) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Failed to create reminder');
    return mapReminder(row);
  }

  listDueReminders(timestamp = nowIso()): ReminderRecord[] {
    const rows = this.db.prepare('SELECT * FROM reminders WHERE status = ? AND due_at <= ? ORDER BY due_at ASC').all('pending', timestamp) as Record<string, unknown>[];
    return rows.map(mapReminder);
  }

  markReminderSent(reminderId: number, timestamp = nowIso()): void {
    this.db.prepare('UPDATE reminders SET status = ?, sent_at = ? WHERE id = ?').run('sent', timestamp, reminderId);
  }

  createNotificationJob(params: {
    type: JobType;
    matchId: number;
    userId: string;
    reminderId?: number | null;
    nextAttemptAt?: string;
    createdAt?: string;
  }): NotificationJob {
    const createdAt = params.createdAt ?? nowIso();
    const nextAttemptAt = params.nextAttemptAt ?? createdAt;
    const reminderKey = params.reminderId == null ? 'none' : String(params.reminderId);
    const dedupeKey = `${params.type}:${params.matchId}:${params.userId}:${reminderKey}`;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_jobs
         (dedupe_key, type, match_id, user_id, reminder_id, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(dedupeKey, params.type, params.matchId, params.userId, params.reminderId ?? null, nextAttemptAt, createdAt);

    const row = this.db.prepare('SELECT * FROM notification_jobs WHERE dedupe_key = ?').get(dedupeKey) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Failed to create notification job');
    return mapJob(row);
  }

  listDueNotificationJobs(timestamp = nowIso(), limit = 50): NotificationJob[] {
    const rows = this.db
      .prepare('SELECT * FROM notification_jobs WHERE status IN (?, ?) AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, id ASC LIMIT ?')
      .all('pending', 'failed', timestamp, limit) as Record<string, unknown>[];
    return rows.map(mapJob);
  }

  markJobSent(jobId: number, slackChannelId: string, slackTs: string, timestamp = nowIso()): void {
    this.db
      .prepare('UPDATE notification_jobs SET status = ?, attempts = attempts + 1, sent_at = ?, slack_channel_id = ?, slack_ts = ?, error = NULL WHERE id = ?')
      .run('sent', timestamp, slackChannelId, slackTs, jobId);
  }

  markJobFailed(jobId: number, error: string, nextAttemptAt: string): void {
    this.db
      .prepare('UPDATE notification_jobs SET status = ?, attempts = attempts + 1, next_attempt_at = ?, error = ? WHERE id = ?')
      .run('failed', nextAttemptAt, error.slice(0, 1000), jobId);
  }

  recordFeedback(matchId: number, responderUserId: string, outcome: FeedbackOutcome, timestamp = nowIso()): FeedbackResponse {
    const result = this.db
      .prepare('INSERT INTO feedback_responses (match_id, responder_user_id, outcome, created_at) VALUES (?, ?, ?, ?)')
      .run(matchId, responderUserId, outcome, timestamp);
    const row = this.db.prepare('SELECT * FROM feedback_responses WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>;
    return {
      id: Number(row.id),
      matchId: Number(row.match_id),
      responderUserId: String(row.responder_user_id),
      outcome: row.outcome as FeedbackOutcome,
      createdAt: String(row.created_at),
    };
  }

  listFeedbackForMatch(matchId: number): FeedbackResponse[] {
    const rows = this.db.prepare('SELECT * FROM feedback_responses WHERE match_id = ? ORDER BY id ASC').all(matchId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      matchId: Number(row.match_id),
      responderUserId: String(row.responder_user_id),
      outcome: row.outcome as FeedbackOutcome,
      createdAt: String(row.created_at),
    }));
  }

  saveCalendarIdentity(identity: Omit<CalendarIdentity, 'createdAt' | 'updatedAt'>, timestamp = nowIso()): CalendarIdentity {
    this.db
      .prepare(
        `INSERT INTO calendar_identities (slack_user_id, provider, calendar_email, calendar_id, verified_at, created_at, updated_at)
         VALUES (@slackUserId, @provider, @calendarEmail, @calendarId, @verifiedAt, @timestamp, @timestamp)
         ON CONFLICT(slack_user_id) DO UPDATE SET
           provider = excluded.provider,
           calendar_email = excluded.calendar_email,
           calendar_id = excluded.calendar_id,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`,
      )
      .run({ ...identity, timestamp });
    return this.getCalendarIdentity(identity.slackUserId)!;
  }

  getCalendarIdentity(slackUserId: string): CalendarIdentity | null {
    const row = this.db.prepare('SELECT * FROM calendar_identities WHERE slack_user_id = ?').get(slackUserId) as Record<string, unknown> | undefined;
    return row ? mapCalendarIdentity(row) : null;
  }

  saveVerifiedInviteAddress(address: Omit<VerifiedInviteAddress, 'createdAt' | 'updatedAt'>, timestamp = nowIso()): VerifiedInviteAddress {
    this.db
      .prepare(
        `INSERT INTO verified_invite_addresses (slack_user_id, email, source, verified_at, created_at, updated_at)
         VALUES (@slackUserId, @email, @source, @verifiedAt, @timestamp, @timestamp)
         ON CONFLICT(slack_user_id) DO UPDATE SET
           email = excluded.email,
           source = excluded.source,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`,
      )
      .run({ ...address, timestamp });
    return this.getVerifiedInviteAddress(address.slackUserId)!;
  }

  getVerifiedInviteAddress(slackUserId: string): VerifiedInviteAddress | null {
    const row = this.db.prepare('SELECT * FROM verified_invite_addresses WHERE slack_user_id = ?').get(slackUserId) as Record<string, unknown> | undefined;
    return row ? mapInviteAddress(row) : null;
  }

  saveSchedulingPreference(preference: SchedulingPreference, timestamp = nowIso()): SchedulingPreference {
    this.db
      .prepare(
        `INSERT INTO scheduling_preferences
          (slack_user_id, duration_minutes, search_horizon_days, min_notice_hours, preferred_start, preferred_end, automated_scheduling_enabled, updated_at)
         VALUES (@slackUserId, @durationMinutes, @searchHorizonDays, @minNoticeHours, @preferredStart, @preferredEnd, @enabled, @timestamp)
         ON CONFLICT(slack_user_id) DO UPDATE SET
          duration_minutes = excluded.duration_minutes,
          search_horizon_days = excluded.search_horizon_days,
          min_notice_hours = excluded.min_notice_hours,
          preferred_start = excluded.preferred_start,
          preferred_end = excluded.preferred_end,
          automated_scheduling_enabled = excluded.automated_scheduling_enabled,
          updated_at = excluded.updated_at`,
      )
      .run({ ...preference, enabled: preference.automatedSchedulingEnabled ? 1 : 0, timestamp });
    return this.getSchedulingPreference(preference.slackUserId)!;
  }

  getSchedulingPreference(slackUserId: string): SchedulingPreference | null {
    const row = this.db.prepare('SELECT * FROM scheduling_preferences WHERE slack_user_id = ?').get(slackUserId) as Record<string, unknown> | undefined;
    return row ? mapPreference(row) : null;
  }

  createSchedulingRequest(matchId: number, timestamp = nowIso()): SchedulingRequest {
    this.db
      .prepare('INSERT OR IGNORE INTO scheduling_requests (match_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(matchId, 'pending', timestamp, timestamp);
    const request = this.getSchedulingRequestByMatch(matchId);
    if (!request) throw new Error(`Failed to create scheduling request for match ${matchId}`);
    return request;
  }

  getSchedulingRequest(requestId: number): SchedulingRequest | null {
    const row = this.db.prepare('SELECT * FROM scheduling_requests WHERE id = ?').get(requestId) as Record<string, unknown> | undefined;
    return row ? mapSchedulingRequest(row) : null;
  }

  getSchedulingRequestByMatch(matchId: number): SchedulingRequest | null {
    const row = this.db.prepare('SELECT * FROM scheduling_requests WHERE match_id = ?').get(matchId) as Record<string, unknown> | undefined;
    return row ? mapSchedulingRequest(row) : null;
  }

  listSchedulingRequestsByStatus(statuses: SchedulingStatus[], limit = 50): SchedulingRequest[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM scheduling_requests WHERE status IN (${placeholders}) ORDER BY updated_at ASC, id ASC LIMIT ?`)
      .all(...statuses, limit) as Record<string, unknown>[];
    return rows.map(mapSchedulingRequest);
  }

  updateSchedulingRequestStatus(requestId: number, status: SchedulingStatus, options: { error?: string | null; selectedSlotId?: string | null; providerEventId?: string | null; providerEventUrl?: string | null } = {}, timestamp = nowIso()): void {
    this.db
      .prepare(
        `UPDATE scheduling_requests
         SET status = ?,
             error = COALESCE(?, error),
             selected_slot_id = COALESCE(?, selected_slot_id),
             provider_event_id = COALESCE(?, provider_event_id),
             provider_event_url = COALESCE(?, provider_event_url),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(status, options.error ?? null, options.selectedSlotId ?? null, options.providerEventId ?? null, options.providerEventUrl ?? null, timestamp, requestId);
  }

  markSchedulingProposed(requestId: number, selectedSlotId?: string | null, timestamp = nowIso()): void {
    this.db.prepare('UPDATE scheduling_requests SET status = ?, selected_slot_id = ?, error = NULL, updated_at = ? WHERE id = ?').run('proposed', selectedSlotId ?? null, timestamp, requestId);
  }

  markSchedulingManual(requestId: number, reason: string | null = null, timestamp = nowIso()): void {
    this.db.prepare('UPDATE scheduling_requests SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status NOT IN (?, ?, ?, ?)').run('manual', reason, timestamp, requestId, 'manual', 'booked', 'failed', 'expired');
  }

  markSchedulingBooked(requestId: number, slotId: string, providerEventId: string, providerEventUrl: string | null = null, timestamp = nowIso()): void {
    this.db.prepare('UPDATE scheduling_candidate_slots SET status = ? WHERE request_id = ? AND id = ?').run('booked', requestId, slotId);
    this.db.prepare('UPDATE scheduling_requests SET status = ?, selected_slot_id = ?, provider_event_id = ?, provider_event_url = ?, error = NULL, updated_at = ? WHERE id = ?').run('booked', slotId, providerEventId, providerEventUrl, timestamp, requestId);
  }

  markSchedulingFailed(requestId: number, reason: string, timestamp = nowIso()): void {
    this.db.prepare('UPDATE scheduling_requests SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status NOT IN (?, ?, ?, ?)').run('failed', reason.slice(0, 1000), timestamp, requestId, 'manual', 'booked', 'failed', 'expired');
  }

  expireSchedulingForMatch(matchId: number, timestamp = nowIso()): void {
    this.db.prepare('UPDATE scheduling_requests SET status = ?, updated_at = ? WHERE match_id = ? AND status NOT IN (?, ?, ?, ?)').run('expired', timestamp, matchId, 'manual', 'booked', 'failed', 'expired');
  }

  saveCandidateSlots(requestId: number, slots: Array<Omit<SchedulingCandidateSlot, 'requestId' | 'createdAt' | 'status'> & { status?: SchedulingSlotStatus }>, timestamp = nowIso()): SchedulingCandidateSlot[] {
    const insert = this.db.prepare(
      `INSERT INTO scheduling_candidate_slots (id, request_id, starts_at, ends_at, status, score, reasons_json, created_at)
       VALUES (@id, @requestId, @startsAt, @endsAt, @status, @score, @reasonsJson, @timestamp)
       ON CONFLICT(id) DO UPDATE SET
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         status = excluded.status,
         score = excluded.score,
         reasons_json = excluded.reasons_json`,
    );
    this.transaction(() => {
      for (const slot of slots) {
        insert.run({ ...slot, requestId, status: slot.status ?? 'active', reasonsJson: JSON.stringify(slot.reasons), timestamp });
      }
    });
    return this.listCandidateSlots(requestId);
  }

  listCandidateSlots(requestId: number, status?: SchedulingSlotStatus): SchedulingCandidateSlot[] {
    const rows = status
      ? (this.db.prepare('SELECT * FROM scheduling_candidate_slots WHERE request_id = ? AND status = ? ORDER BY score ASC, starts_at ASC').all(requestId, status) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM scheduling_candidate_slots WHERE request_id = ? ORDER BY score ASC, starts_at ASC').all(requestId) as Record<string, unknown>[]);
    return rows.map(mapCandidateSlot);
  }

  getCandidateSlot(requestId: number, slotId: string): SchedulingCandidateSlot | null {
    const row = this.db.prepare('SELECT * FROM scheduling_candidate_slots WHERE request_id = ? AND id = ?').get(requestId, slotId) as Record<string, unknown> | undefined;
    return row ? mapCandidateSlot(row) : null;
  }

  markSlotsInactiveExcept(requestId: number, activeSlotIds: string[], timestamp = nowIso()): void {
    if (activeSlotIds.length === 0) {
      this.db.prepare('UPDATE scheduling_candidate_slots SET status = ? WHERE request_id = ? AND status = ?').run('inactive', requestId, 'active');
      return;
    }
    const placeholders = activeSlotIds.map(() => '?').join(', ');
    this.db.prepare(`UPDATE scheduling_candidate_slots SET status = ? WHERE request_id = ? AND status = ? AND id NOT IN (${placeholders})`).run('inactive', requestId, 'active', ...activeSlotIds);
  }

  recordSchedulingResponse(params: { requestId: number; slackUserId: string; response: SchedulingResponseType; slotId?: string | null; text?: string | null }, timestamp = nowIso()): SchedulingResponse {
    const result = this.db
      .prepare('INSERT INTO scheduling_responses (request_id, slack_user_id, response, slot_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(params.requestId, params.slackUserId, params.response, params.slotId ?? null, params.text ?? null, timestamp);
    const row = this.db.prepare('SELECT * FROM scheduling_responses WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>;
    return mapSchedulingResponse(row);
  }

  listSchedulingResponses(requestId: number): SchedulingResponse[] {
    const rows = this.db.prepare('SELECT * FROM scheduling_responses WHERE request_id = ? ORDER BY id ASC').all(requestId) as Record<string, unknown>[];
    return rows.map(mapSchedulingResponse);
  }

  latestAcceptedUsersForSlot(requestId: number, slotId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT slack_user_id, response FROM scheduling_responses
         WHERE request_id = ? AND (slot_id = ? OR slot_id IS NULL)
         ORDER BY id ASC`,
      )
      .all(requestId, slotId) as Array<{ slack_user_id: string; response: SchedulingResponseType }>;
    const accepted = new Set<string>();
    for (const row of rows) {
      if (row.response === 'accepted') accepted.add(row.slack_user_id);
      if (row.response === 'rejected' || row.response === 'alternatives' || row.response === 'manual') accepted.delete(row.slack_user_id);
    }
    return accepted;
  }

  addSchedulingMessage(requestId: number, role: SchedulingMessageRole, content: string, timestamp = nowIso()): SchedulingMessage {
    const result = this.db.prepare('INSERT INTO scheduling_messages (request_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(requestId, role, content, timestamp);
    const row = this.db.prepare('SELECT * FROM scheduling_messages WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>;
    return mapSchedulingMessage(row);
  }

  listSchedulingMessages(requestId: number): SchedulingMessage[] {
    const rows = this.db.prepare('SELECT * FROM scheduling_messages WHERE request_id = ? ORDER BY id ASC').all(requestId) as Record<string, unknown>[];
    return rows.map(mapSchedulingMessage);
  }

  createSchedulingNotificationJob(params: { type: SchedulingNotificationType; requestId: number; userId: string; slotId?: string | null; dedupeKey?: string; nextAttemptAt?: string; createdAt?: string }): SchedulingNotificationJob {
    const createdAt = params.createdAt ?? nowIso();
    const nextAttemptAt = params.nextAttemptAt ?? createdAt;
    const slotKey = params.slotId ?? 'none';
    const dedupeKey = params.dedupeKey ?? `${params.type}:${params.requestId}:${params.userId}:${slotKey}`;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO scheduling_notification_jobs
         (dedupe_key, type, request_id, user_id, slot_id, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(dedupeKey, params.type, params.requestId, params.userId, params.slotId ?? null, nextAttemptAt, createdAt);
    const row = this.db.prepare('SELECT * FROM scheduling_notification_jobs WHERE dedupe_key = ?').get(dedupeKey) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Failed to create scheduling notification job');
    return mapSchedulingNotification(row);
  }

  listDueSchedulingNotificationJobs(timestamp = nowIso(), limit = 50): SchedulingNotificationJob[] {
    const rows = this.db
      .prepare('SELECT * FROM scheduling_notification_jobs WHERE status IN (?, ?) AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, id ASC LIMIT ?')
      .all('pending', 'failed', timestamp, limit) as Record<string, unknown>[];
    return rows.map(mapSchedulingNotification);
  }

  markSchedulingNotificationSent(jobId: number, slackChannelId: string, slackTs: string, timestamp = nowIso()): void {
    this.db.prepare('UPDATE scheduling_notification_jobs SET status = ?, attempts = attempts + 1, sent_at = ?, slack_channel_id = ?, slack_ts = ?, error = NULL WHERE id = ?').run('sent', timestamp, slackChannelId, slackTs, jobId);
  }

  markSchedulingNotificationFailed(jobId: number, error: string, nextAttemptAt: string): void {
    this.db.prepare('UPDATE scheduling_notification_jobs SET status = ?, attempts = attempts + 1, next_attempt_at = ?, error = ? WHERE id = ?').run('failed', nextAttemptAt, error.slice(0, 1000), jobId);
  }
}
