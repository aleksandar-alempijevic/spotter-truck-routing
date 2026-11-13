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
