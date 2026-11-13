import { expect, test } from 'vitest';
import { HORIZON_HOURS, MAX_LOAD_LB, SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from '../plan/trip';
import { DALLAS, scenarioDestination } from '../test/fixtures';
import { HOUR_MS, toLocalInput } from '../time/zone';
import {
  canSearch,
  INITIAL_VALUES,
  parseLoad,
  tooShortToSearch,
  validateTrip,
  type FormValues,
} from './validation';

const NOW = Date.parse('2026-11-20T14:00:00Z');
const DENVER = scenarioDestination('mixed');

const values = (over: Partial<FormValues> = {}): FormValues => ({
  ...INITIAL_VALUES,
  origin: DALLAS,
  originText: DALLAS.label,
  destination: DENVER,
  destinationText: DENVER.label,
  loadText: '36,000',
  ...over,
});

const at = (ms: number): FormValues['departure'] => ({
  mode: 'at',
  local: toLocalInput(ms, DALLAS.timezone),
});

test.each([
  ['', 'Enter the cargo weight in pounds.'],
  ['   ', 'Enter the cargo weight in pounds.'],
  ['abc', 'Use numbers only.'],
  ['12x', 'Use numbers only.'],
  ['-5', 'Use numbers only.'],
  ['0', 'The weight must be more than 0 lb.'],
  ['0.0', 'The weight must be more than 0 lb.'],
  ['80,001', 'The weight can be at most 80,000 lb.'],
])('the load %j is refused with its reason', (text, error) => {
  expect(parseLoad(text)).toEqual({ error });
});

test.each([
  ['36,000', 36_000],
  ['36 000', 36_000],
  ['0.5', 0.5],
  [String(MAX_LOAD_LB), MAX_LOAD_LB],
])('the load %j is read as %d lb', (text, value) => {
  expect(parseLoad(text)).toEqual({ value });
});

test('address search needs the minimum and stops at the maximum', () => {
  expect(canSearch('a'.repeat(SEARCH_MIN_CHARS - 1))).toBe(false);
  expect(canSearch('a'.repeat(SEARCH_MIN_CHARS))).toBe(true);
  expect(canSearch('a'.repeat(SEARCH_MAX_CHARS))).toBe(true);
  expect(canSearch('a'.repeat(SEARCH_MAX_CHARS + 1))).toBe(false);
  expect(canSearch('  ab  ')).toBe(false);
  expect(tooShortToSearch('')).toBe(false);
  expect(tooShortToSearch('ab')).toBe(true);
  expect(tooShortToSearch('abc')).toBe(false);
});

test('a complete form gives a trip with the load, the spacing and the departure resolved', () => {
  const result = validateTrip(values(), NOW);
  expect(result.errors).toBeNull();
  expect(result.trip).toMatchObject({ loadLb: 36_000, spacing: 25, departureMs: NOW });
});

test('every missing part is named at once', () => {
  const { errors } = validateTrip(
    values({
      origin: null,
      originText: '',
      destination: null,
      destinationText: 'Den',
      loadText: '',
    }),
    NOW,
  );
  expect(errors).toEqual({
    origin: 'Choose a starting place.',
    destination: 'Choose a destination from the suggestions.',
    load: 'Enter the cargo weight in pounds.',
  });
});

test('the destination may not be the starting place, by label or by position', () => {
  expect(validateTrip(values({ destination: DALLAS }), NOW).errors?.destination).toBe(
    'The destination must differ from the starting place.',
  );
  const sameSpot = { ...DENVER, label: 'Somewhere else', lat: DALLAS.lat, lon: DALLAS.lon };
  expect(validateTrip(values({ destination: sameSpot }), NOW).errors?.destination).toBe(
    'The destination must differ from the starting place.',
  );
});

test('a picked time needs the starting place first, and a real date', () => {
  expect(validateTrip(values({ origin: null, departure: at(NOW) }), NOW).errors?.departure).toMatch(
    /Choose the starting place first/,
  );
  expect(
    validateTrip(values({ departure: { mode: 'at', local: '' } }), NOW).errors?.departure,
  ).toBe('Enter a departure date and time.');
});

test('the departure window: a few minutes back are forgiven, the past is not, 48 hours is the limit', () => {
  const minute = 60_000;
  const ok = (ms: number) => validateTrip(values({ departure: at(ms) }), NOW).errors;
  // The field reads minutes, so the instants sit on whole minutes.
  expect(ok(NOW - 9 * minute)).toBeNull();
  expect(ok(NOW - 11 * minute)?.departure).toBe('That time has already passed.');
  expect(ok(NOW + HORIZON_HOURS * HOUR_MS - 2 * minute)).toBeNull();
  expect(ok(NOW + HORIZON_HOURS * HOUR_MS)?.departure).toBe(
    `Departure can be at most ${HORIZON_HOURS} hours ahead.`,
  );
});

test('"Leave now" is resolved against the time of the press', () => {
  const result = validateTrip(values({ departure: { mode: 'now' } }), NOW + 5 * HOUR_MS);
  expect(result.trip?.departureMs).toBe(NOW + 5 * HOUR_MS);
});
