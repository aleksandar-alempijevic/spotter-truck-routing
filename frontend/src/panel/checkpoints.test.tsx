import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { buildPlanView } from '../plan/view';
import type { Trip } from '../plan/trip';
import { buildRoutes, buildWeather, DALLAS, scenarioDestination } from '../test/fixtures';
import { LIVE_ROUTES, LIVE_WEATHER } from '../test/live';
import { CheckpointRow, conditionParts, decisionText } from './CheckpointList';
import { RouteCards } from './RouteCards';

afterEach(cleanup);

const departure = '2026-11-20T14:00:00Z';
const trip = (): Trip => ({
  origin: DALLAS,
  destination: scenarioDestination('mixed'),
  departureMs: Date.parse(departure),
  loadLb: 36_000,
  spacing: 25,
  addressCredit: null,
});

test('readings from a real answer are rounded for reading, not printed to many decimals', () => {
  const view = buildPlanView(LIVE_ROUTES, LIVE_WEATHER);
  const parts = conditionParts(view.routes[0].checkpoints[0]).map((p) => p.text);
  expect(parts).toEqual(['Wind 11 mph (gusts 25)', 'Rain 0 in/h', 'Snow 0 in/h']);
});

test('a checkpoint says which condition set its level, and when the load raised it', () => {
  const view = buildPlanView(
    buildRoutes('mixed', { departure }),
    buildWeather('mixed', { departure }),
  );
  const route = view.routes[0];
  const raised = route.checkpoints.find((c) => c.risk.kind === 'level' && c.risk.loadRaised)!;
  expect(decisionText(raised)).toBe('Set by wind, raised a level by the load');
  const snow = view.routes[2].checkpoints.find(
    (c) => c.risk.kind === 'level' && c.risk.condition === 'snow',
  )!;
  expect(decisionText(snow)).toBe('Set by snow');
  const low = route.checkpoints[0];
  expect(decisionText(low)).toBeNull();

  render(
    <CheckpointRow
      route={route}
      cp={raised}
      trip={trip()}
      isSelected={false}
      onSelect={() => {}}
    />,
  );
  expect(screen.getByText('Set by wind, raised a level by the load')).toBeInTheDocument();
});

test('a checkpoint with no forecast or no weather yet says so and has no decision line', () => {
  const view = buildPlanView(
    buildRoutes('mixed', { departure }),
    buildWeather('mixed', { departure }),
  );
  const none = view.routes[2].checkpoints.find((c) => c.risk.kind === 'none')!;
  expect(decisionText(none)).toBeNull();
  const pending = buildPlanView(buildRoutes('mixed', { departure })).routes[0].checkpoints[0];
  expect(decisionText(pending)).toBeNull();
  expect(conditionParts(none)).toEqual([]);
});

test('a card with No Travel miles carries a text banner, and one without does not', () => {
  const view = buildPlanView(
    buildRoutes('mixed', { departure }),
    buildWeather('mixed', { departure }),
  );
  render(
    <RouteCards
      routes={view.routes}
      trip={trip()}
      selectedId={null}
      recommendedId={null}
      onSelect={() => {}}
    />,
  );
  expect(screen.getAllByRole('note')).toHaveLength(1);
  expect(screen.getByRole('note')).toHaveTextContent(/No Travel on \d+ mi of this route/);
  expect(screen.getByText(/No forecast \d+ mi/)).toBeInTheDocument();
});
