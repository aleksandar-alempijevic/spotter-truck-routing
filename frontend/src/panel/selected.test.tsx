import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { displayZone, type Trip } from '../plan/trip';
import { buildPlanView } from '../plan/view';
import { buildRoutes, buildWeather, DALLAS } from '../test/fixtures';
import { buildGridModel } from '../timeline/grid';
import { createHourHolder } from '../timeline/hourHolder';
import { HourSlider } from '../timeline/HourSlider';
import { RouteCards } from './RouteCards';
import { RouteChips } from './RouteChips';

afterEach(cleanup);

const departure = '2026-11-20T14:00:00Z';
const view = buildPlanView(
  buildRoutes('mixed', { departure }),
  buildWeather('mixed', { departure }),
);
const trip: Trip = {
  origin: DALLAS,
  destination: { ...DALLAS, label: 'Denver, CO, United States' },
  departureMs: Date.parse(departure),
  loadLb: 36_000,
  spacing: 25,
  restBreaks: false,
  addressCredit: null,
};
const noop = () => {};

/** The check mark is the one SVG circle drawn inside a pressed button. */
const marks = () => document.querySelectorAll('button[aria-pressed=true] svg circle').length;

test('the selected card carries a check mark besides its border, and only the selected one', () => {
  render(
    <RouteCards
      routes={view.routes}
      trip={trip}
      selectedId="route-2"
      recommendedId={null}
      breaksApplied={false}
      onSelect={noop}
    />,
  );
  expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('Route 2');
  expect(marks()).toBe(1);
  expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(2);
});

test('a card holds no heading or paragraph inside its button', () => {
  render(
    <RouteCards
      routes={view.routes}
      trip={trip}
      selectedId="route-2"
      recommendedId={null}
      breaksApplied={false}
      onSelect={noop}
    />,
  );
  expect(
    document.querySelectorAll('button h1, button h2, button h3, button h4, button h5, button h6'),
  ).toHaveLength(0);
  expect(document.querySelectorAll('button p')).toHaveLength(0);
});

test('the selected chip carries the same check mark, and chips hold no paragraph in a button', () => {
  render(
    <RouteChips routes={view.routes} selectedId="route-3" recommendedId={null} onSelect={noop} />,
  );
  expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('Route 3');
  expect(marks()).toBe(1);
  expect(document.querySelectorAll('button p')).toHaveLength(0);
});

test('the slider clock is not a live region: the slider announces its own value', () => {
  const weather = buildWeather('mixed', { departure });
  const model = buildGridModel(weather.grid, departure);
  const { container } = render(
    <HourSlider holder={createHourHolder(1)} model={model} zone={displayZone(trip)} />,
  );
  expect(container.querySelector('[aria-live]')).toBeNull();
  expect(screen.getByRole('slider', { name: 'Forecast hour' })).toBeInTheDocument();
});
