import { DateTime } from 'luxon';
import type { AppConfig, Frequency } from './types.js';
import { frequencyIntervalDays } from './config.js';

const localIsoWithoutOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

export function isValidIanaTimezone(timezone: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

export function validateFirstPairingLocal(value: string): boolean {
  if (!localIsoWithoutOffset.test(value)) return false;
  const parsed = DateTime.fromISO(value, { zone: 'UTC' });
  return parsed.isValid;
}

export interface ScheduleValidationInput {
  coffeeChannelId: string;
  firstPairingLocal: string;
  frequency: Frequency;
  timezone: string;
  reminderDelayDays: number;
}

export function validateScheduleInput(input: ScheduleValidationInput): string[] {
  const errors: string[] = [];
  if (!/^(C|G)[A-Z0-9]+$/.test(input.coffeeChannelId)) {
    errors.push('Coffee channel must be a Slack channel ID starting with C or G.');
  }
  if (!validateFirstPairingLocal(input.firstPairingLocal)) {
    errors.push('First pairing date/time must be a local ISO-8601 date-time without UTC offset, e.g. 2026-06-03T10:00.');
  }
  if (input.frequency !== 'weekly' && input.frequency !== 'biweekly') {
    errors.push('Frequency must be weekly or biweekly.');
  }
  if (!isValidIanaTimezone(input.timezone)) {
    errors.push('Timezone must be a valid IANA timezone, e.g. Europe/Berlin.');
  }
  const intervalDays = input.frequency === 'weekly' || input.frequency === 'biweekly' ? frequencyIntervalDays(input.frequency) : 0;
  if (!Number.isInteger(input.reminderDelayDays) || input.reminderDelayDays <= 0 || (intervalDays > 0 && input.reminderDelayDays >= intervalDays)) {
    errors.push('Reminder delay must be a positive integer number of days less than the pairing interval.');
  }
  return errors;
}

export function localDateTimeToUtcIso(localDateTime: string, timezone: string): string {
  const parsed = DateTime.fromISO(localDateTime, { zone: timezone });
  if (!parsed.isValid) {
    throw new Error(parsed.invalidExplanation ?? `Invalid date-time ${localDateTime}`);
  }
  return parsed.toUTC().toISO({ suppressMilliseconds: true })!;
}

export function scheduledAtForSequence(config: Pick<AppConfig, 'firstPairingLocal' | 'timezone' | 'frequency'>, sequence: number): string {
  if (sequence < 1) throw new Error('Sequence must be >= 1');
  const intervalDays = frequencyIntervalDays(config.frequency);
  const first = DateTime.fromISO(config.firstPairingLocal, { zone: config.timezone });
  if (!first.isValid) throw new Error(first.invalidExplanation ?? 'Invalid first pairing date/time');
  return first.plus({ days: intervalDays * (sequence - 1) }).toUTC().toISO({ suppressMilliseconds: true })!;
}

export function nextScheduledSequence(config: Pick<AppConfig, 'firstPairingLocal' | 'timezone' | 'frequency'>, afterSequence: number): { sequence: number; scheduledAt: string } {
  const sequence = afterSequence + 1;
  return { sequence, scheduledAt: scheduledAtForSequence(config, sequence) };
}

export function dueScheduledTimes(config: Pick<AppConfig, 'firstPairingLocal' | 'timezone' | 'frequency'>, afterSequence: number, nowUtcIso: string, maxCount = 10): Array<{ sequence: number; scheduledAt: string }> {
  const due: Array<{ sequence: number; scheduledAt: string }> = [];
  let sequence = afterSequence + 1;
  const now = DateTime.fromISO(nowUtcIso, { zone: 'utc' });

  while (due.length < maxCount) {
    const scheduledAt = scheduledAtForSequence(config, sequence);
    const scheduled = DateTime.fromISO(scheduledAt, { zone: 'utc' });
    if (scheduled > now) break;
    due.push({ sequence, scheduledAt });
    sequence += 1;
  }

  return due;
}

export function addDaysUtc(isoUtc: string, days: number): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' }).plus({ days }).toUTC().toISO({ suppressMilliseconds: true })!;
}
