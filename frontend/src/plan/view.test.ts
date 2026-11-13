import { expect, test } from 'vitest';
import { ApiError } from '../api/client';
import { buildRoutes, buildWeather } from '../test/fixtures';
import { buildPlanView, checkAligned } from './view';
import { buildWeatherBody } from './weatherRequest';

const departure = '2026-11-20T14:00:00Z';

test('before the weather lands every checkpoint is pending, never Low', () => {
  const view = buildPlanView(buildRoutes('mixed', { departure }));
  expect(view.weatherReady).toBe(false);
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
    'total_miles',
    'travel_time_seconds',
  ]);
  expect(body.routes[1].checkpoints).toEqual(routes.routes[1].checkpoints);
  expect(body).not.toHaveProperty('shortfall');
});
