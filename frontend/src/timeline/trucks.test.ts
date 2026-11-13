import { expect, test } from 'vitest';
import { buildRoutes, buildWeather } from '../test/fixtures';
import { buildPlanView } from '../plan/view';
import { describeTruck, mileAt, pointAtMile, trucksAt, type TruckRoute } from './trucks';

const H = 3_600_000;
const T0 = Date.parse('2026-11-20T14:00:00Z');

const straight: TruckRoute = {
  id: 'r',
  name: 'Route 1',
  miles: 100,
  line: [
    [-100, 40],
    [-99, 40],
    [-98, 40],
  ],
  checkpoints: [
    { mile: 0, etaMs: T0 },
    { mile: 50, etaMs: T0 + 1 * H },
    { mile: 100, etaMs: T0 + 2 * H },
  ],
};

test('before the first ETA the truck has not left, and at the last it has arrived', () => {
  expect(mileAt(straight.checkpoints, 100, T0 - 1)).toEqual({ status: 'before', mile: 0 });
  expect(mileAt(straight.checkpoints, 100, T0)).toEqual({ status: 'driving', mile: 0 });
  expect(mileAt(straight.checkpoints, 100, T0 + 2 * H)).toEqual({ status: 'arrived', mile: 100 });
  expect(mileAt(straight.checkpoints, 100, T0 + 9 * H).status).toBe('arrived');
});

test('between two checkpoints the mile is interpolated from their ETAs', () => {
  expect(mileAt(straight.checkpoints, 100, T0 + 0.5 * H).mile).toBeCloseTo(25);
  expect(mileAt(straight.checkpoints, 100, T0 + 1.5 * H).mile).toBeCloseTo(75);
});

test('uneven ETAs are followed, not a constant speed: a slow stretch stays slow', () => {
  // 25 miles take 30 minutes, then 25 miles take 3 hours.
  const uneven = [
    { mile: 0, etaMs: T0 },
    { mile: 25, etaMs: T0 + 0.5 * H },
    { mile: 50, etaMs: T0 + 3.5 * H },
  ];
  expect(mileAt(uneven, 50, T0 + 0.25 * H).mile).toBeCloseTo(12.5);
  expect(mileAt(uneven, 50, T0 + 2 * H).mile).toBeCloseTo(25 + 25 * (1.5 / 3));
});

test('two checkpoints with the same ETA do not divide by zero', () => {
  const same = [
    { mile: 0, etaMs: T0 },
    { mile: 25, etaMs: T0 + H },
    { mile: 50, etaMs: T0 + H },
    { mile: 75, etaMs: T0 + 2 * H },
  ];
  const { mile } = mileAt(same, 75, T0 + H);
  expect(Number.isFinite(mile)).toBe(true);
  expect(mile).toBeGreaterThanOrEqual(25);
});

test('the point follows the line and scales its length to the route miles', () => {
  expect(pointAtMile(straight.line, 100, 0)).toEqual([-100, 40]);
  expect(pointAtMile(straight.line, 100, 100)).toEqual([-98, 40]);
  const [lon, lat] = pointAtMile(straight.line, 100, 50);
  expect(lon).toBeCloseTo(-99, 3);
  expect(lat).toBeCloseTo(40, 3);
  // The route says 200 miles for the same line: mile 100 is now the middle.
  expect(pointAtMile(straight.line, 200, 100)[0]).toBeCloseTo(-99, 3);
});

test('a bent line is followed round its corner', () => {
  const bent: TruckRoute['line'] = [
    [-100, 40],
    [-100, 41],
    [-99, 41],
  ];
  const [lon, lat] = pointAtMile(bent, 100, 25);
  expect(lon).toBeCloseTo(-100, 3);
  expect(lat).toBeGreaterThan(40);
  expect(lat).toBeLessThan(41.01);
  expect(pointAtMile(bent, 100, 90)[1]).toBeCloseTo(41, 1);
});

test('a degenerate line or route does not throw', () => {
  expect(pointAtMile([], 10, 5)).toEqual([0, 0]);
  expect(pointAtMile([[-100, 40]], 10, 5)).toEqual([-100, 40]);
  expect(pointAtMile(straight.line, 0, 5)).toEqual([-100, 40]);
  expect(mileAt([], 0, T0).status).toBe('before');
});

test('trucks read from the real fixtures: one per route, all on the road at the departure hour', () => {
  const departure = '2026-11-20T14:00:00Z';
  const view = buildPlanView(
    buildRoutes('mixed', { departure }),
    buildWeather('mixed', { departure }),
  );
  const trucks = trucksAt(view.routes, Date.parse(departure) + 3 * H);
  expect(trucks.map((t) => t.routeId)).toEqual(['route-1', 'route-2', 'route-3']);
  expect(trucks.every((t) => t.status === 'driving')).toBe(true);
  // The fastest route is furthest along after three hours.
  expect(trucks[0].mile).toBeGreaterThan(trucks[2].mile);
  const later = trucksAt(view.routes, Date.parse(departure) + 40 * H);
  expect(later.every((t) => t.status === 'arrived')).toBe(true);
});

test('truck wording', () => {
  const t = (status: 'before' | 'driving' | 'arrived', mile = 0) => ({
    routeId: 'r',
    name: 'Route 1',
    status,
    mile,
    position: [0, 0] as [number, number],
  });
  expect(describeTruck(t('before'))).toBe('Route 1 not left yet');
  expect(describeTruck(t('driving', 240.4))).toBe('Route 1 at mile 240');
  expect(describeTruck(t('arrived', 788))).toBe('Route 1 arrived');
});
