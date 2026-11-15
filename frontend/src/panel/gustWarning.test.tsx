import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { describeCheckpoint, describeRouteGust } from '../plan/describe';
import type { ConditionsOut } from '../api/types';
import type { Trip } from '../plan/trip';
import { buildPlanView } from '../plan/view';
import { buildRoutes, buildWeather, DALLAS, scenarioDestination } from '../test/fixtures';
import { CheckpointRow, StopRow } from './CheckpointList';
import { PlanPanel } from './PlanPanel';
import { RouteChips } from './RouteChips';
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

type Scenario = Parameters<typeof buildWeather>[0];

/** A scenario with every gust calm; each test then spikes the points it is about. */
function calmWeather(scenario: Scenario, breaks = false) {
  const weather = buildWeather(scenario, { departure, breaks });
  const calm = <T extends { weather: ConditionsOut | null }>(point: T) => {
    if (point.weather) point.weather = { ...point.weather, gust_mph: 20, gust_warning: false };
  };
  for (const route of weather.routes) {
    route.checkpoints.forEach(calm);
    route.stops.forEach(calm);
  }
  return weather;
}

const viewOf = (scenario: Scenario, weather: ReturnType<typeof calmWeather>, breaks = false) =>
  buildPlanView(buildRoutes(scenario, { departure, breaks }), weather);

/** The one-route scenario, calm except one checkpoint's gust set the way the server reports it. */
function viewWithGust(gust: number, gustWarning: boolean) {
  const weather = calmWeather('oneRoute');
  const point = weather.routes[0].checkpoints.find((c) => c.weather)!;
  point.weather = { ...point.weather!, gust_mph: gust, gust_warning: gustWarning };
  return viewOf('oneRoute', weather);
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
  expect(describeRouteGust(gusty.routes[0].gustMph)?.line).toBe(
    'Gusts to 58 mph on this route — risk of blow-over for light or empty trailers',
  );
  expect(viewWithGust(44.9, false).routes[0].gustMph).toBeNull();

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

test('the phone route chips carry the warning on the chip', () => {
  const gusty = viewWithGust(58, true);

  render(
    <RouteChips
      routes={gusty.routes}
      selectedId={gusty.routes[0].id}
      recommendedId={null}
      onSelect={() => {}}
    />,
  );

  expect(screen.getByText('Gust 58 mph')).toBeInTheDocument();
});

test("the phone panel says the selected route's warning in full under the chips", () => {
  const gusty = viewWithGust(58, true);
  const state = {
    phase: 'ready',
    view: gusty,
    explanation: null,
    weather: undefined,
    routesError: null,
    weatherError: null,
    routesAt: 0,
    retryRoutes: () => {},
    retryWeather: () => {},
  } as const;

  render(
    <PlanPanel
      tier="peek"
      state={state}
      submission={{ id: 1, trip: trip(), startedAt: 0 }}
      selectedRouteId={gusty.routes[0].id}
      selectedCheckpoint={null}
      selectedStop={null}
      onSelectRoute={() => {}}
      onSelectCheckpoint={() => {}}
      onEditTrip={() => {}}
    />,
  );

  expect(
    screen.getByText(
      'Gusts to 58 mph on this route — risk of blow-over for light or empty trailers',
    ),
  ).toBeInTheDocument();
  expect(screen.getAllByText(/^Warning:/)).toHaveLength(2);
});

test('chips without a warning show none', () => {
  const calm = viewWithGust(44.9, false);
  render(
    <RouteChips
      routes={calm.routes}
      selectedId={calm.routes[0].id}
      recommendedId={null}
      onSelect={() => {}}
    />,
  );
  expect(screen.queryByText(/Gust/)).toBeNull();
});

/** The mixed scenario with rest stops, calm except the first stop of the first route. */
function viewWithOnlyAStopGusting() {
  const weather = calmWeather('mixed', true);
  const stop = weather.routes[0].stops.find((s) => s.weather)!;
  stop.weather = { ...stop.weather!, gust_mph: 63, gust_warning: true };
  return viewOf('mixed', weather, true);
}

test('a gust at a rest stop alone warns on the stop row and on the route card', () => {
  const view = viewWithOnlyAStopGusting();
  const route = view.routes[0];
  expect(route.checkpoints.every((c) => c.conditions?.gust_warning !== true)).toBe(true);
  const stop = route.stops.find((s) => s.conditions?.gust_warning)!;

  const { unmount } = render(<StopRow stop={stop} trip={trip()} isSelected={false} />);
  expect(screen.getByText(/Gusts to 63 mph — risk of blow-over/)).toBeInTheDocument();
  unmount();

  render(
    <RouteCards
      routes={[route]}
      trip={trip()}
      selectedId={null}
      recommendedId={null}
      breaksApplied
      onSelect={() => {}}
    />,
  );
  expect(screen.getByText(/Gusts to 63 mph on this route/)).toBeInTheDocument();
});

test('a reading without the flag, as an older answer has it, shows no warning and does not crash', () => {
  const weather = calmWeather('oneRoute');
  const point = weather.routes[0].checkpoints.find((c) => c.weather)!;
  point.weather = { ...point.weather!, gust_mph: 90 };
  delete (point.weather as { gust_warning?: boolean }).gust_warning;
  const view = viewOf('oneRoute', weather);
  const cp = view.routes[0].checkpoints.find((c) => c.conditions)!;

  expect(describeCheckpoint(cp).gustWarning).toBeNull();
  expect(view.routes[0].gustMph).toBeNull();
});
