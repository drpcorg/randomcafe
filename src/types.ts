export type Frequency = 'weekly' | 'biweekly';
export type CycleStatus = 'open' | 'completed' | 'failed';
export type MatchOutcome = 'active' | 'met' | 'cancelled' | 'expired';
export type FeedbackOutcome = 'met' | 'not_yet' | 'cannot_meet';
export type JobType = 'pair_notification' | 'reminder';
export type JobStatus = 'pending' | 'sent' | 'failed';

export type CalendarProvider = 'google' | 'fake';
export type CalendarAgentFallbackMode = 'manual' | 'failed';
export type SchedulingStatus = 'pending' | 'proposed' | 'manual' | 'booked' | 'failed' | 'expired';
export type SchedulingSlotStatus = 'active' | 'inactive' | 'booked';
export type SchedulingResponseType = 'accepted' | 'rejected' | 'alternatives' | 'text_preference' | 'manual';
export type SchedulingMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type SchedulingNotificationType = 'proposal' | 'manual' | 'booked' | 'failed' | 'no_slots';

export interface AppConfig {
  coffeeChannelId: string;
  firstPairingLocal: string;
  frequency: Frequency;
  timezone: string;
  reminderDelayDays: number;
  maxParticipants: number;
  matchCandidateAttempts: number;
  maxRemindersPerMatch: number;
  updatedAt: string;
}

export interface RuntimeConfig {
  slackBotToken: string;
  slackAppToken: string;
  adminUserIds: Set<string>;
  databasePath: string;
  logLevel: string;
  schedulerIntervalSeconds: number;
  maxParticipants: number;
  matchCandidateAttempts: number;
  maxRemindersPerMatch: number;
  calendarSchedulingEnabled: boolean;
  calendarProvider: CalendarProvider;
  calendarGoogleCredentialsJson?: string;
  calendarGoogleSubject?: string;
  calendarBotCalendarId?: string;
  calendarDefaultDurationMinutes: number;
  calendarSearchHorizonDays: number;
  calendarMinimumNoticeHours: number;
  calendarDefaultPreferredStart: string;
  calendarDefaultPreferredEnd: string;
  calendarAgentFallbackMode: CalendarAgentFallbackMode;
  piProvider: string;
  piModel: string;
  piAgentTimeoutMs: number;
}

export interface SlackUser {
  id: string;
  name?: string;
  realName?: string;
  email?: string;
  isBot?: boolean;
  deleted?: boolean;
}

export interface Participant {
  slackUserId: string;
  displayName?: string;
}

export interface CycleRecord {
  id: number;
  scheduledAt: string;
  sequence: number;
  status: CycleStatus;
  failureReason?: string | null;
  createdAt: string;
  closedAt?: string | null;
}

export interface MatchRecord {
  id: number;
  cycleId: number;
  userA: string;
  userB: string;
  outcome: MatchOutcome;
  reminderCount: number;
  createdAt: string;
  closedAt?: string | null;
}

export interface ReminderRecord {
  id: number;
  matchId: number;
  sequence: number;
  dueAt: string;
  status: JobStatus;
  sentAt?: string | null;
  createdAt: string;
}

export interface NotificationJob {
  id: number;
  type: JobType;
  matchId: number;
  userId: string;
  reminderId?: number | null;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: string;
  sentAt?: string | null;
  slackChannelId?: string | null;
  slackTs?: string | null;
  error?: string | null;
  createdAt: string;
}

export interface FeedbackResponse {
  id: number;
  matchId: number;
  responderUserId: string;
  outcome: FeedbackOutcome;
  createdAt: string;
}

export interface PairHistoryEntry {
  userA: string;
  userB: string;
  lastSequence: number;
}

export interface MatchPair {
  userA: string;
  userB: string;
}

export interface MatchPlan {
  pairs: MatchPair[];
  skippedUserId?: string;
  score: number;
  attemptedCandidates: number;
}

export interface CalendarIdentity {
  slackUserId: string;
  provider: CalendarProvider | string;
  calendarEmail: string;
  calendarId: string;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface VerifiedInviteAddress {
  slackUserId: string;
  email: string;
  source: 'calendar' | 'slack' | 'manual';
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulingPreference {
  slackUserId: string;
  durationMinutes: number;
  searchHorizonDays: number;
  minNoticeHours: number;
  preferredStart: string;
  preferredEnd: string;
  automatedSchedulingEnabled: boolean;
  updatedAt: string;
}

export interface SchedulingRequest {
  id: number;
  matchId: number;
  status: SchedulingStatus;
  selectedSlotId?: string | null;
  providerEventId?: string | null;
  providerEventUrl?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulingCandidateSlot {
  id: string;
  requestId: number;
  startsAt: string;
  endsAt: string;
  status: SchedulingSlotStatus;
  score: number;
  reasons: string[];
  createdAt: string;
}

export interface SchedulingResponse {
  id: number;
  requestId: number;
  slackUserId: string;
  response: SchedulingResponseType;
  slotId?: string | null;
  text?: string | null;
  createdAt: string;
}

export interface SchedulingMessage {
  id: number;
  requestId: number;
  role: SchedulingMessageRole;
  content: string;
  createdAt: string;
}

export interface SchedulingNotificationJob {
  id: number;
  type: SchedulingNotificationType;
  requestId: number;
  userId: string;
  slotId?: string | null;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: string;
  sentAt?: string | null;
  slackChannelId?: string | null;
  slackTs?: string | null;
  error?: string | null;
  createdAt: string;
}
