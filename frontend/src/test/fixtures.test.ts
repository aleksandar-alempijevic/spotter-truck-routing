import { describe, expect, it } from 'vitest';
import type { RoutesIn, RoutesOut } from '../api/types';
import {
  buildRoutes,
  buildWeather,
  fixtureElapsed,
  fixtureStops,
  SCENARIO_KEYS,
  scenarioDestination,
} from './fixtures';
import { LIVE_ROUTES } from './live';
import { createStandIn } from './standIn';

const H = 3600;
const DEPARTURE = '2026-11-14T12:00:00.000Z';

/** The wire's duration invariants, over any routes answer in either mode. */
function expectDurationInvariants(routes: RoutesOut) {
  for (const route of routes.routes) {
    const etas = route.checkpoints.map((c) => Date.parse(c.eta));
    const stoppedS = route.stops.reduce((sum, stop) => sum + stop.duration_seconds, 0);
    expect(etas).toEqual([...etas].sort((a, b) => a - b));
    // Last ETA minus first is the door-to-door time on the wire.
    expect((etas.at(-1)! - etas[0]) / 1000).toBeCloseTo(route.travel_time_seconds, -1);
    expect(route.travel_time_seconds - route.driving_seconds).toBe(stoppedS);
    if (!routes.breaks_applied) {
      expect(route.stops).toEqual([]);
      expect(route.driving_seconds).toBe(route.travel_time_seconds);
    }
    for (const stop of route.stops) {
      const start = Date.parse(stop.starts_at);
      const end = start + stop.duration_seconds * 1000;
      const before = route.checkpoints.filter((c) => Date.parse(c.eta) <= start).at(-1)!;
      const after = route.checkpoints.find((c) => Date.parse(c.eta) >= end)!;
      expect(before.mile).toBeLessThanOrEqual(stop.mile);
      expect(stop.mile).toBeLessThanOrEqual(after.mile);
    }
  }
}

describe('the fixture rule', () => {
  it('places stops around each limit', () => {
    const kinds = (drivingS: number) => fixtureStops(drivingS).map((s) => [s.kind, s.drivingS / H]);
    expect(kinds(8 * H)).toEqual([]);
    expect(kinds(8 * H + 1)).toEqual([['break', 8]]);
    expect(kinds(11 * H)).toEqual([['break', 8]]);
    expect(kinds(11 * H + 1)).toEqual([
      ['break', 8],
      ['rest', 11],
    ]);
    expect(kinds(19 * H + 1).at(-1)).toEqual(['break', 19]);
  });

  it('reaches a point at a stop before the stop and a later one after it', () => {
    const stops = fixtureStops(12 * H);
    expect(fixtureElapsed(stops, 8 * H)).toBe(8 * H);
    expect(fixtureElapsed(stops, 8 * H + 1)).toBe(8 * H + 1 + 30 * 60);
    expect(fixtureElapsed(stops, 12 * H)).toBe(12 * H + 30 * 60 + 10 * H);
  });

  it('is enough for every scenario: none drives 60 hours, where the cycle limit would start', () => {
    for (const key of SCENARIO_KEYS) {
      const routes = buildRoutes(key, { departure: DEPARTURE });
      for (const route of routes.routes) expect(route.driving_seconds).toBeLessThan(60 * H);
    }
  });
});

describe.each(SCENARIO_KEYS)('the %s routes scenario', (key) => {
  it('is self-consistent with breaks off, and has no stops', () => {
    const routes = buildRoutes(key, { departure: DEPARTURE });

    expect(routes.breaks_applied).toBe(false);
    expectDurationInvariants(routes);
  });

  it('is self-consistent with breaks on', () => {
    const routes = buildRoutes(key, { departure: DEPARTURE, breaks: true });

    expect(routes.breaks_applied).toBe(true);
    expectDurationInvariants(routes);
  });

  it('keeps ids, lines and marks the same in both modes and changes only times', () => {
    const off = buildRoutes(key, { departure: DEPARTURE });
    const on = buildRoutes(key, { departure: DEPARTURE, breaks: true });

    off.routes.forEach((plain, i) => {
      const broken = on.routes[i];
      expect(broken.id).toBe(plain.id);
      expect(broken.line).toEqual(plain.line);
      expect(broken.driving_seconds).toBe(plain.driving_seconds);
      expect(broken.checkpoints.map(({ mile, lat, lon }) => [mile, lat, lon])).toEqual(
        plain.checkpoints.map(({ mile, lat, lon }) => [mile, lat, lon]),
      );
      // A trip under 8 hours at the wheel is identical apart from the echo.
      if (plain.driving_seconds <= 8 * H) expect(broken).toEqual(plain);
    });
  });
});

describe('the scenarios the browser run needs', () => {
  it('has a trip with one break and one rest, one under 8 hours and a multi-day trip', () => {
    const kinds = (key: Parameters<typeof buildRoutes>[0]) =>
      buildRoutes(key, { departure: DEPARTURE, breaks: true }).routes[0].stops.map((s) => s.kind);

    expect(kinds('mixed')).toEqual(['break', 'rest']);
    expect(kinds('oneRoute')).toEqual([]);
    expect(kinds('crossCountry').length).toBeGreaterThan(4);
  });
});

describe('the live fixture as an off-mode answer', () => {
  it('is in the current contract: driving time is travel time, no stops, breaks not applied', () => {
    expect(LIVE_ROUTES.breaks_applied).toBe(false);
    expectDurationInvariants(LIVE_ROUTES);
  });
});

describe('the weather fixture in either mode', () => {
  it('ranks on the travel time the routes answer carries', () => {
    const options = { departure: DEPARTURE, breaks: true };
    const routes = buildRoutes('tie', options);
    const lost = buildWeather('tie', options).ranking.routes[1].vs_first!;

    expect(lost.travel_time_seconds).toBe(
      routes.routes[1].travel_time_seconds - routes.routes[0].travel_time_seconds,
    );
  });
});

describe('the stand-in', () => {
  const ask = (answer: ReturnType<typeof createStandIn>, extra: Partial<RoutesIn>) =>
    answer(
      'POST',
      '/api/routes',
      JSON.stringify({
        load_lb: 36_000,
        checkpoint_interval_miles: 25,
        origin: { lat: 32.78, lon: -96.8 },
        destination: scenarioDestination('mixed'),
        departure: DEPARTURE,
        ...extra,
      }),
    ).body as RoutesOut;

  it('answers without breaks when the field is omitted or false', () => {
    const answer = createStandIn();

    for (const extra of [{}, { rest_breaks: false }]) {
      const body = ask(answer, extra);
      expect(body.breaks_applied).toBe(false);
      expect(body.routes.every((r) => r.stops.length === 0)).toBe(true);
    }
  });

  it('honours the request field, so a browser run can switch breaks on', () => {
    const body = ask(createStandIn(), { rest_breaks: true });

    expect(body.breaks_applied).toBe(true);
    expect(body.routes[0].stops.length).toBeGreaterThan(0);
  });
});
