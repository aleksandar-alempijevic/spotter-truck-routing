import { expect, test } from 'vitest';
import { buildRoutes, buildWeather, type ScenarioKey } from '../test/fixtures';
import { describe, explain } from './explain';
import { buildPlanView } from './view';

const departure = '2026-11-20T14:00:00Z';

function explainScenario(key: ScenarioKey) {
  const weather = buildWeather(key, { departure });
  const view = buildPlanView(buildRoutes(key, { departure }), weather);
  const explanation = explain(weather.ranking, view.routes);
  return { explanation, view, text: describe(explanation, view.routes) };
}

test('a decided plan names the winner, the deciding step and the time cost', () => {
  const { explanation, text, view } = explainScenario('mixed');
  expect(explanation).toMatchObject({ kind: 'decided', routeId: 'route-2', step: 'severe' });
  expect(explanation.kind === 'decided' && explanation.timeCostSeconds).toBe(
    view.routes[1].travelSeconds - view.routes[0].travelSeconds,
  );
  expect(text.headline).toBe('Route 2 is recommended');
  expect(text.reason).toBe('Fewest Severe miles.');
  expect(text.cost).toMatch(/^\+.* against the fastest route \(Route 1\)\.$/);
});

test('second and third place are listed in rank order with no reason between them', () => {
  const { explanation } = explainScenario('mixed');
  expect(explanation.others).toEqual([
    { routeId: 'route-3', rank: 2 },
    { routeId: 'route-1', rank: 3 },
  ]);
  expect(Object.keys(explanation.others[0])).toEqual(['routeId', 'rank']);
});

test('a decision at the travel-time step says risk was tied', () => {
  const { explanation, text } = explainScenario('tie');
  expect(explanation).toMatchObject({ kind: 'decided', step: 'travel_time', timeCostSeconds: 0 });
  expect(text.reason).toBe('Tied on risk, so the shortest travel time decides.');
  expect(text.cost).toBe('It is also the fastest route.');
});

test.each([
  ['miles', 'Tied on risk and travel time, so the fewest miles decides.'],
  ['route_id', 'No difference on any measure, so the first route listed is taken.'],
] as const)('a tie-break at %s is worded as a tie-break', (step, reason) => {
  const weather = buildWeather('tie', { departure });
  weather.ranking.decided_by = step;
  const view = buildPlanView(buildRoutes('tie', { departure }), weather);
  expect(describe(explain(weather.ranking, view.routes), view.routes).reason).toBe(reason);
});

test('no recommendation reads as no route safe to recommend', () => {
  const { explanation, text } = explainScenario('noneSafe');
  expect(explanation).toMatchObject({ kind: 'none_safe', firstRankedId: 'route-2' });
  expect(text.headline).toBe('No route is safe to recommend');
  expect(text.reason).toBe('Every route has No Travel miles. Route 2 has the fewest.');
});

test('a one-route plan has no deciding step and no comparison', () => {
  const { explanation, text } = explainScenario('oneRoute');
  expect(explanation).toMatchObject({ kind: 'one_route', routeId: 'route-1' });
  expect(text).toEqual({
    headline: 'Route 1 is recommended',
    reason: 'It is the only route.',
    cost: null,
  });
});

test('a one-route plan whose route has No Travel miles is not recommended', () => {
  const weather = buildWeather('oneRoute', { departure });
  weather.ranking.recommended_id = null;
  weather.ranking.decided_by = null;
  const view = buildPlanView(buildRoutes('oneRoute', { departure }), weather);
  const text = describe(explain(weather.ranking, view.routes), view.routes);
  expect(text.reason).toBe('The only route has No Travel miles.');
});

test('a recommended route that is not the first-listed one is explained against the fastest', () => {
  const { explanation } = explainScenario('shortfall');
  expect(explanation).toMatchObject({
    kind: 'decided',
    routeId: 'route-2',
    fastestId: expect.any(String),
  });
});

// ---------- the criteria behind first place ----------

import type { RankingOut } from '../api/types';
import { LIVE_ROUTES, LIVE_WEATHER } from '../test/live';

const row = (c: ReturnType<typeof criteriaOf>, step: string) =>
  c.rows.find((r) => r.step === step)!;

function criteriaOf(key: ScenarioKey) {
  const { explanation } = explainScenario(key);
  if (!('criteria' in explanation) || !explanation.criteria) throw new Error('no criteria');
  return explanation.criteria;
}

test('the rows run through the deciding step and mark it', () => {
  const c = criteriaOf('mixed');
  expect(c.rows.map((r) => r.step)).toEqual(['no_travel', 'severe']);
  expect(c.rows.map((r) => r.decides)).toEqual([false, true]);
});

test('a route that survived a step is a tie there, with the difference the ranking supplies', () => {
  const c = criteriaOf('mixed');
  expect(row(c, 'no_travel').tiedWith).toEqual(['route-3', 'route-1']);
  const standing = row(c, 'no_travel').standings[0].standing;
  expect(standing).toMatchObject({ kind: 'tie' });
  expect(standing.kind === 'tie' && typeof standing.difference).toBe('number');
  expect(row(c, 'severe').tiedWith).toEqual([]);
  expect(row(c, 'severe').standings.every((s) => s.standing.kind === 'lost')).toBe(true);
});

test('a tie at a tie-break step carries no difference, because the ranking supplies none', () => {
  const weather = buildWeather('tie', { departure });
  weather.ranking.decided_by = 'miles';
  for (const r of weather.ranking.routes) if (r.vs_first) r.vs_first.dropped_at = 'miles';
  const view = buildPlanView(buildRoutes('tie', { departure }), weather);
  const e = explain(weather.ranking, view.routes);
  if (e.kind !== 'decided') throw new Error('expected a decided plan');
  const miles = e.criteria.rows.find((r) => r.step === 'miles')!;
  expect(miles.standings.every((s) => s.standing.kind === 'lost')).toBe(true);
  const travel = e.criteria.rows.find((r) => r.step === 'travel_time')!;
  expect(travel.standings[0].standing).toMatchObject({
    kind: 'tie',
    difference: expect.any(Number),
  });
  // no step before 'miles' that has no `vs_first` measure may invent one
  expect(e.criteria.rows.at(-2)!.step).toBe('travel_time');
});

test('"lost to" names the route the ranking says, which is not always the winner', () => {
  const ranking: RankingOut = {
    recommended_id: 'b',
    decided_by: 'travel_time',
    routes: [
      { id: 'b', rank: 1, no_forecast_miles: 0, average_risk_tolerance: 0.05, vs_first: null },
      {
        id: 'a',
        rank: 2,
        no_forecast_miles: 0,
        average_risk_tolerance: 0.05,
        vs_first: {
          dropped_at: 'travel_time',
          dropped_against: { best_route_id: 'b', route_value: 900, best_value: 600, tolerance: 0 },
          travel_time_seconds: 300,
          no_travel_miles: 0,
          severe_miles: 0,
          high_miles: 0,
          average_risk: -0.05,
        },
      },
      {
        id: 'c',
        rank: 3,
        no_forecast_miles: 0,
        average_risk_tolerance: 0.05,
        vs_first: {
          dropped_at: 'average_risk',
          dropped_against: { best_route_id: 'a', route_value: 0.1, best_value: 0, tolerance: 0.05 },
          travel_time_seconds: -300,
          no_travel_miles: 0,
          severe_miles: 0,
          high_miles: 0,
          average_risk: 0.05,
        },
      },
    ],
  };
  const e = explain(
    ranking,
    buildPlanView(buildRoutes('mixed', { departure })).routes.map((r, i) => ({
      ...r,
      id: 'abc'[i],
    })),
  );
  if (e.kind !== 'decided') throw new Error('expected a decided plan');
  const avg = e.criteria.rows.find((r) => r.step === 'average_risk')!;
  const c = avg.standings.find((s) => s.routeId === 'c')!.standing;
  expect(c).toMatchObject({
    kind: 'lost',
    againstId: 'a',
    routeValue: 0.1,
    bestValue: 0,
    tolerance: 0.05,
  });
  // a is still in at that step; c is out by the time travel time is applied
  expect(avg.tiedWith).toEqual(['a']);
  const time = e.criteria.rows.find((r) => r.step === 'travel_time')!;
  expect(time.standings.find((s) => s.routeId === 'c')!.standing).toEqual({ kind: 'out' });
});

test('a one-route plan has no criteria; a none-safe plan keeps the ones the ranking decided', () => {
  expect(explainScenario('oneRoute').explanation).not.toHaveProperty('criteria');
  const { explanation } = explainScenario('noneSafe');
  expect(explanation.kind).toBe('none_safe');
  expect(explanation.kind === 'none_safe' && explanation.criteria?.rows.at(-1)).toMatchObject({
    step: 'no_travel',
    decides: true,
  });
});

test('a real answer decided at travel time is a tie on every risk step before it', () => {
  const view = buildPlanView(LIVE_ROUTES, LIVE_WEATHER);
  const e = explain(LIVE_WEATHER.ranking, view.routes);
  if (e.kind !== 'decided') throw new Error('expected a decided plan');
  expect(e.step).toBe('travel_time');
  expect(e.criteria.rows.map((r) => r.step)).toEqual([
    'no_travel',
    'severe',
    'high',
    'average_risk',
    'travel_time',
  ]);
  for (const r of e.criteria.rows.slice(0, 4)) expect(r.tiedWith).toEqual(['route-2', 'route-3']);
  const last = e.criteria.rows[4].standings[0].standing;
  expect(last).toMatchObject({
    kind: 'lost',
    againstId: 'route-1',
    routeValue: 82054,
    bestValue: 69611,
  });
});
