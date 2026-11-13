import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { explain } from '../plan/explain';
import { buildPlanView } from '../plan/view';
import { LIVE_ROUTES, LIVE_WEATHER } from '../test/live';
import { buildRoutes, buildWeather } from '../test/fixtures';
import { WhyThisRoute } from './WhyThisRoute';

afterEach(cleanup);

function setup(departure = '2026-11-20T14:00:00Z') {
  const weather = buildWeather('mixed', { departure });
  const view = buildPlanView(buildRoutes('mixed', { departure }), weather);
  const e = explain(weather.ranking, view.routes);
  if (e.kind !== 'decided') throw new Error('expected a decided plan');
  render(<WhyThisRoute criteria={e.criteria} routes={view.routes} />);
}

test('the criteria are behind an expand', () => {
  setup();
  expect(screen.queryByText('Severe miles')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Why this route?' }));
  expect(screen.getByText('Severe miles')).toBeInTheDocument();
});

test('the deciding step is marked and the others are compared with the winner only', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Why this route?' }));
  expect(screen.getAllByText('Decides')).toHaveLength(1);
  expect(screen.getByText(/compared with Route 2 only, not with each other/)).toBeInTheDocument();
  expect(
    screen.getByText(/Route 3: Left the contest, behind Route 2: .* mi against .* mi/),
  ).toBeInTheDocument();
});

test('ties are marked, with a difference only where the ranking gives one', () => {
  const view = buildPlanView(LIVE_ROUTES, LIVE_WEATHER);
  const e = explain(LIVE_WEATHER.ranking, view.routes);
  if (e.kind !== 'decided') throw new Error('expected a decided plan');
  render(<WhyThisRoute criteria={e.criteria} routes={view.routes} />);
  fireEvent.click(screen.getByRole('button', { name: 'Why this route?' }));
  expect(screen.getAllByText('Tie')).toHaveLength(4);
  expect(screen.getAllByText(/Route 2: Tie \(same against Route 1\)/).length).toBeGreaterThan(0);
  expect(screen.getByText(/Route 2: Tie \(\+0\.02 against Route 1\)/)).toBeInTheDocument();
  expect(
    screen.getByText(/Route 2: Left the contest, behind Route 1: 22 h 48 min against 19 h 20 min/),
  ).toBeInTheDocument();
});
