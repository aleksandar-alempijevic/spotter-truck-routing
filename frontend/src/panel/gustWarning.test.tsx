import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { describeCheckpoint, routeGustWarning } from '../plan/describe';
import type { Trip } from '../plan/trip';
import { buildPlanView } from '../plan/view';
import { buildRoutes, buildWeather, DALLAS, scenarioDestination } from '../test/fixtures';
import { CheckpointRow } from './CheckpointList';
import { RouteCards } from './RouteCards';

afterEach(cleanup);

const departure = '2026-11-20T14:00:00Z';
const trip = (): Trip => ({
  origin: DALLAS,
  destination: scenarioDestination('oneRoute'),
  departureMs: Date.parse(departure),
  loadLb: 36_000,
  spacing: 25,
  restBreaks: false,
  addressCredit: null,
});

/** A scenario with every gust calm, and one checkpoint's gust set the way the server reports it. */
function viewWithGust(gust: number, gustWarning: boolean) {
  const weather = buildWeather('oneRoute', { departure });
  for (const route of weather.routes) {
    for (const c of route.checkpoints) {
      if (c.weather) c.weather = { ...c.weather, gust_mph: 20, gust_warning: false };
    }
  }
  const point = weather.routes[0].checkpoints.find((c) => c.weather)!;
  point.weather = { ...point.weather!, gust_mph: gust, gust_warning: gustWarning };
  return buildPlanView(buildRoutes('oneRoute', { departure }), weather);
}

test('a gust the server flags shows a warning with the gust on the checkpoint, and not below it', () => {
  const warned = viewWithGust(45, true).routes[0].checkpoints.find((c) => c.conditions)!;
  expect(describeCheckpoint(warned).gustWarning).toBe(
    'Gusts to 45 mph — risk of blow-over for light or empty trailers',
  );
  const quiet = viewWithGust(44.9, false).routes[0].checkpoints.find((c) => c.conditions)!;
  expect(describeCheckpoint(quiet).gustWarning).toBeNull();
});

test('the checkpoint row shows the warning, and the warning leaves the level alone', () => {
  const calm = viewWithGust(20, false).routes[0];
  const gusty = viewWithGust(58, true).routes[0];
  const index = gusty.checkpoints.findIndex((c) => c.conditions?.gust_warning);

  render(
    <CheckpointRow
      route={gusty}
      cp={gusty.checkpoints[index]}
      trip={trip()}
      isSelected={false}
      onSelect={() => {}}
    />,
  );

  expect(screen.getByText(/Gusts to 58 mph — risk of blow-over/)).toBeInTheDocument();
  expect(gusty.checkpoints[index].risk).toEqual(calm.checkpoints[index].risk);
  expect(gusty.risk).toEqual(calm.risk);
  expect(gusty.summary).toEqual(calm.summary);
});

test('the route card says the highest gust on the route, and only when one warns', () => {
  const gusty = viewWithGust(58, true);
  expect(routeGustWarning(gusty.routes[0])).toBe(
    'Gusts to 58 mph on this route — risk of blow-over for light or empty trailers',
  );
  expect(routeGustWarning(viewWithGust(44.9, false).routes[0])).toBeNull();

  render(
    <RouteCards
      routes={gusty.routes}
      trip={trip()}
      selectedId={null}
      recommendedId={null}
      breaksApplied={false}
      onSelect={() => {}}
    />,
  );
  expect(screen.getAllByText(/Gusts to 58 mph on this route/)).toHaveLength(1);
});
