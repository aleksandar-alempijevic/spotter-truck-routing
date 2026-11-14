import { expect, test } from 'vitest';
import { buildRoutes, DALLAS, scenarioDestination } from '../test/fixtures';
import { buildPlanView } from '../plan/view';
import type { Trip } from '../plan/trip';
import { arrivalInDestinationZone, arrivalMs, originClock } from './times';

const departure = '2026-11-16T14:00:00.000Z';
const trip = (destination = scenarioDestination('mixed')): Trip => ({
  origin: DALLAS,
  destination,
  departureMs: Date.parse(departure),
  loadLb: 36_000,
  spacing: 25,
  restBreaks: false,
  addressCredit: null,
});

test('times are read in the origin zone, with the zone named', () => {
  expect(originClock(trip(), Date.parse(departure))).toBe('Mon 08:00 CST');
});

test('the arrival is also given in the destination zone when its clock differs', () => {
  const view = buildPlanView(buildRoutes('mixed', { departure }));
  const ms = arrivalMs(view.routes[0]);
  const denver = { ...scenarioDestination('mixed'), timezone: 'America/Denver' };
  expect(arrivalInDestinationZone(trip(denver), ms)).toMatch(/MST$/);
});

test('no second zone when destination and origin read the same clock', () => {
  const same = { ...scenarioDestination('tie'), timezone: 'America/Chicago' };
  expect(arrivalInDestinationZone(trip(same), Date.parse(departure))).toBeNull();
});
