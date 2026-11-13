import { expect, test } from 'vitest';
import {
  formatClock,
  formatDuration,
  toLocalInput,
  wallClockToInstant,
  zoneAbbreviation,
} from './zone';

const NY = 'America/New_York';

test('a plain wall-clock time becomes the instant it names', () => {
  expect(new Date(wallClockToInstant('2026-07-01T09:30', NY)!).toISOString()).toBe(
    '2026-07-01T13:30:00.000Z',
  );
  expect(new Date(wallClockToInstant('2026-01-15T09:30', 'Europe/Belgrade')!).toISOString()).toBe(
    '2026-01-15T08:30:00.000Z',
  );
});

test('spring forward: a time that does not exist lands an hour later on the clock', () => {
  const ms = wallClockToInstant('2026-03-08T02:30', NY)!;
  expect(new Date(ms).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  expect(toLocalInput(ms, NY)).toBe('2026-03-08T03:30');
});

test('fall back: an ambiguous time is the earlier one', () => {
  const ms = wallClockToInstant('2026-11-01T01:30', NY)!;
  expect(new Date(ms).toISOString()).toBe('2026-11-01T05:30:00.000Z');
});

test('times either side of a change keep their own offsets', () => {
  expect(new Date(wallClockToInstant('2026-03-08T01:59', NY)!).toISOString()).toBe(
    '2026-03-08T06:59:00.000Z',
  );
  expect(new Date(wallClockToInstant('2026-03-08T03:00', NY)!).toISOString()).toBe(
    '2026-03-08T07:00:00.000Z',
  );
  expect(new Date(wallClockToInstant('2026-11-01T02:00', NY)!).toISOString()).toBe(
    '2026-11-01T07:00:00.000Z',
  );
});

test('a value that is not a local date-time is refused', () => {
  expect(wallClockToInstant('', NY)).toBeNull();
  expect(wallClockToInstant('2026-07-01', NY)).toBeNull();
});

test('toLocalInput round-trips through wallClockToInstant', () => {
  const ms = Date.UTC(2026, 6, 4, 18, 45);
  expect(wallClockToInstant(toLocalInput(ms, 'America/Chicago'), 'America/Chicago')).toBe(ms);
});

test('clock formatting reads the stated zone', () => {
  const ms = Date.UTC(2026, 6, 7, 19, 0); // a Tuesday
  expect(formatClock(ms, 'America/Chicago')).toBe('Tue 14:00');
  expect(zoneAbbreviation(ms, 'America/Chicago')).toBe('CDT');
});

test('midnight reads 00, never 24', () => {
  expect(formatClock(Date.UTC(2026, 6, 8, 5, 0), 'America/Chicago')).toBe('Wed 00:00');
});

test.each([
  [35 * 60, '35 min'],
  [3600, '1 h'],
  [4 * 3600 + 5 * 60, '4 h 05 min'],
  [27 * 3600, '1 d 3 h'],
])('formatDuration(%i)', (seconds, text) => {
  expect(formatDuration(seconds)).toBe(text);
});
