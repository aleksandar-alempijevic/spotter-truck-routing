import { expect, test } from 'vitest';
import { ApiError } from '../api/client';
import { buildRoutes, buildWeather } from '../test/fixtures';
import { describeCheckpoint } from './describe';
import { stopEndMs } from './schedule';
import { buildPlanView, checkAligned } from './view';
import { buildWeatherBody } from './weatherRequest';

const departure = '2026-11-20T14:00:00Z';

test('before the weather lands every checkpoint is pending, never Low', () => {
  const view = buildPlanView(buildRoutes('mixed', { departure }));
  expect(view.weather).toBe('pending');
  const states = view.routes.flatMap((r) => r.checkpoints.map((c) => c.risk.kind));
  expect(new Set(states)).toEqual(new Set(['pending']));
  expect(view.routes.every((r) => r.summary === null && r.rank === null)).toBe(true);
});

test('weather joins by route id and checkpoint index', () => {
  const routes = buildRoutes('mixed', { departure });
  const weather = buildWeather('mixed', { departure });
  weather.routes.reverse(); // the join must not rely on order
  const view = buildPlanView(routes, weather);

  const route2 = view.routes.find((r) => r.id === 'route-2')!;
  const wire = weather.routes.find((r) => r.id === 'route-2')!;
  expect(route2.checkpoints).toHaveLength(wire.checkpoints.length);
  route2.checkpoints.forEach((cp, i) => {
    const risk = wire.checkpoints[i].risk;
    expect(cp.risk.kind).toBe(risk ? 'level' : 'none');
    expect(cp.mile).toBe(routes.routes[1].checkpoints[i].mile);
  });
  expect(view.routes.find((r) => r.id === 'route-2')!.rank).toBe(1);
});

test('the weather state is one value: a failure wins over data left from an earlier answer', () => {
  const routes = buildRoutes('mixed', { departure });
  const weather = buildWeather('mixed', { departure });
  expect(buildPlanView(routes, weather).weather).toBe('ready');
  expect(buildPlanView(routes, weather, true).weather).toBe('failed');
});

test('a null forecast is "none" and carries no conditions', () => {
  const view = buildPlanView(
    buildRoutes('mixed', { departure }),
    buildWeather('mixed', { departure }),
  );
  const tail = view.routes[2].checkpoints.at(-1)!;
  expect(tail.risk).toEqual({ kind: 'none' });
  expect(tail.conditions).toBeNull();
});

test('a load-raised level keeps its flag and condition', () => {
  const view = buildPlanView(
    buildRoutes('mixed', { departure }),
    buildWeather('mixed', { departure }),
  );
  const raised = view.routes[0].checkpoints.find(
    (c) => c.risk.kind === 'level' && c.risk.loadRaised,
  );
  expect(raised?.risk).toMatchObject({ level: 'severe', condition: 'wind', loadRaised: true });
});

test('the fastest route is computed, and the via city names a route', () => {
  const routes = buildRoutes('mixed', { departure });
  routes.routes[2].travel_time_seconds = 1; // make the last route the fastest
  const view = buildPlanView(routes);
  expect(view.routes.map((r) => r.isFastest)).toEqual([false, false, true]);
  expect(view.routes[1].via).toBe('Wichita');
  expect(view.routes[0].via).toBeNull();
});

test('the shortfall message is carried verbatim', () => {
  const routes = buildRoutes('shortfall', { departure });
  expect(buildPlanView(routes).shortfall).toBe(routes.shortfall!.message);
  expect(buildPlanView(buildRoutes('mixed', { departure })).shortfall).toBeNull();
});

test.each([
  [
    'a missing route id',
    (w: ReturnType<typeof buildWeather>) => {
      w.routes[0].id = 'route-9';
    },
  ],
  [
    'a different checkpoint count',
    (w: ReturnType<typeof buildWeather>) => {
      w.routes[1].checkpoints.pop();
    },
  ],
  [
    'a missing route',
    (w: ReturnType<typeof buildWeather>) => {
      w.routes.pop();
    },
  ],
  [
    'an unknown recommended route',
    (w: ReturnType<typeof buildWeather>) => {
      w.ranking.recommended_id = 'route-9';
    },
  ],
])('%s is refused as an unknown failure, not partially joined', (_name, tamper) => {
  const routes = buildRoutes('mixed', { departure });
  const weather = buildWeather('mixed', { departure });
  tamper(weather);
  expect(() => checkAligned(routes, weather)).toThrow(ApiError);
  try {
    checkAligned(routes, weather);
  } catch (e) {
    expect((e as ApiError).code).toBe('unknown');
  }
});

test('an aligned answer passes', () => {
  expect(() =>
    checkAligned(buildRoutes('mixed', { departure }), buildWeather('mixed', { departure })),
  ).not.toThrow();
});

test('the weather request is the send-back subset and nothing else', () => {
  const routes = buildRoutes('mixed', { departure, spacing: 50, loadLb: 41_000 });
  const body = buildWeatherBody(routes);
  expect(body.load_lb).toBe(41_000);
  expect(body.checkpoint_interval_miles).toBe(50);
  expect(Object.keys(body.routes[0]).sort()).toEqual([
    'checkpoints',
    'id',
    'stops',
    'total_miles',
    'travel_time_seconds',
  ]);
  expect(body.routes[1].checkpoints).toEqual(routes.routes[1].checkpoints);
  expect(body).not.toHaveProperty('shortfall');
});

test('a failed weather request reads as unavailable everywhere the view is read, not pending', () => {
  const view = buildPlanView(buildRoutes('mixed', { departure }), undefined, true);
  expect(view.weather).toBe('failed');
  for (const route of view.routes) {
    expect(route.risk).toEqual({ kind: 'unavailable' });
    expect(route.checkpoints.every((cp) => cp.risk.kind === 'unavailable')).toBe(true);
  }
  const cp = view.routes[0].checkpoints[0];
  expect(describeCheckpoint(cp)).toMatchObject({
    level: 'Weather unavailable',
    note: 'Weather could not be loaded',
  });
});

const withBreaks = { departure, breaks: true };

test('the mode comes from the routes answer: breaks applied, driving time and stops', () => {
  const off = buildPlanView(buildRoutes('mixed', { departure }));
  const on = buildPlanView(buildRoutes('mixed', withBreaks));

  expect(off.breaksApplied).toBe(false);
  expect(off.routes.every((r) => r.stops.length === 0)).toBe(true);
  expect(off.routes.every((r) => r.drivingSeconds === r.travelSeconds)).toBe(true);
  expect(on.breaksApplied).toBe(true);
  const first = on.routes[0];
  expect(first.stops.map((s) => s.kind)).toEqual(['break', 'rest']);
  expect(first.travelSeconds).toBe(
    first.drivingSeconds + first.stops.reduce((sum, s) => sum + s.durationSeconds, 0),
  );
  expect(stopEndMs(first.stops[0]) - first.stops[0].startMs).toBe(30 * 60_000);
});

test('the echo is read, not inferred: a trip with no stops still says breaks were applied', () => {
  const view = buildPlanView(buildRoutes('oneRoute', withBreaks));

  expect(view.routes[0].stops).toEqual([]);
  expect(view.breaksApplied).toBe(true);
});

test('stops never enter the checkpoint list, so checkpoint indexes and the weather join hold', () => {
  const off = buildRoutes('mixed', { departure });
  const on = buildRoutes('mixed', withBreaks);
  const weather = buildWeather('mixed', withBreaks);

  const view = buildPlanView(on, weather);

  view.routes.forEach((route, r) => {
    expect(route.checkpoints.map((c) => c.index)).toEqual(route.checkpoints.map((_, i) => i));
    expect(route.checkpoints.map((c) => c.mile)).toEqual(
      off.routes[r].checkpoints.map((c) => c.mile),
    );
    expect(route.checkpoints).toHaveLength(weather.routes[r].checkpoints.length);
  });
  expect(() => checkAligned(on, weather)).not.toThrow();
});

test("the weather request carries each route's stops in the send-back subset", () => {
  const routes = buildRoutes('mixed', { departure, breaks: true });

  const body = buildWeatherBody(routes);

  body.routes.forEach((route, i) => {
    expect(route.stops).toEqual(routes.routes[i].stops);
    expect(route.stops!.length).toBeGreaterThan(0);
    expect(Object.keys(route.stops![0]).sort()).toEqual([
      'duration_seconds',
      'kind',
      'lat',
      'lon',
      'mile',
      'starts_at',
    ]);
  });
  expect(buildWeatherBody(buildRoutes('mixed', { departure })).routes[0].stops).toEqual([]);
});

test('a stop reads its weather like a checkpoint: a level, no forecast, pending or unavailable', () => {
  const routes = buildRoutes('mixed', { departure, breaks: true });
  const weather = buildWeather('mixed', { departure, breaks: true });
  weather.routes[0].stops[0] = { mile: 1, at: null, weather: null, risk: null };

  const view = buildPlanView(routes, weather);
  const [none, level] = view.routes[0].stops;

  expect(none.risk).toEqual({ kind: 'none' });
  expect(none.conditions).toBeNull();
  expect(none.readAtMs).toBeNull();
  expect(level.risk.kind).toBe('level');
  expect(level.conditions).not.toBeNull();
  expect(level.readAtMs).toBe(Date.parse(weather.routes[0].stops[1].at!));
  expect(buildPlanView(routes).routes[0].stops.every((s) => s.risk.kind === 'pending')).toBe(true);
  expect(
    buildPlanView(routes, undefined, true).routes[0].stops.every(
      (s) => s.risk.kind === 'unavailable',
    ),
  ).toBe(true);
});

test("stops take no part in a route's risk, summary or ranking, however bad their weather", () => {
  const routes = buildRoutes('mixed', { departure, breaks: true });
  const calm = buildWeather('mixed', { departure, breaks: true });
  const stormy = structuredClone(calm);
  for (const route of stormy.routes) {
    route.stops = route.stops.map((stop) => ({
      ...stop,
      weather: { wind_mph: 70, gust_mph: 90, rain_in_per_hr: 0, snow_in_per_hr: 0 },
      risk: { level: 'no_travel', condition: 'wind', load_raised: false },
    }));
  }

  const before = buildPlanView(routes, calm);
  const after = buildPlanView(routes, stormy);

  expect(after.routes[0].stops.every((s) => s.risk.kind === 'level')).toBe(true);
  after.routes.forEach((route, i) => {
    expect(route.risk).toEqual(before.routes[i].risk);
    expect(route.summary).toEqual(before.routes[i].summary);
    expect(route.rank).toBe(before.routes[i].rank);
    expect(route.checkpoints.map((c) => c.risk)).toEqual(
      before.routes[i].checkpoints.map((c) => c.risk),
    );
  });
  expect(after.ranking).toEqual(before.ranking);
  expect(after.routes.some((r) => r.risk.kind === 'level' && r.risk.level === 'no_travel')).toBe(
    before.routes.some((r) => r.risk.kind === 'level' && r.risk.level === 'no_travel'),
  );
});

test('a weather answer with another number of stops than its routes is not aligned', () => {
  const routes = buildRoutes('mixed', { departure, breaks: true });
  const weather = buildWeather('mixed', { departure, breaks: true });
  weather.routes[1].stops.pop();

  expect(() => checkAligned(routes, weather)).toThrow(ApiError);
});
