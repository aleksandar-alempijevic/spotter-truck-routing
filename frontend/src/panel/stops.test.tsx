import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { stopEndMs } from '../plan/schedule';
import type { Trip } from '../plan/trip';
import { buildPlanView } from '../plan/view';
import { buildRoutes, buildWeather, DALLAS, scenarioDestination } from '../test/fixtures';
import { formatDuration } from '../time/zone';
import { CheckpointList } from './CheckpointList';
import { RouteCards } from './RouteCards';
import type { StopView } from '../plan/view';
import { interleave, splitText, stopWhat } from './stops';

afterEach(cleanup);

const departure = '2026-11-20T14:00:00Z';
const trip: Trip = {
  origin: DALLAS,
  destination: scenarioDestination('mixed'),
  departureMs: Date.parse(departure),
  loadLb: 36_000,
  spacing: 25,
  restBreaks: false,
  addressCredit: null,
};
const planFor = (breaks: boolean) =>
  buildPlanView(
    buildRoutes('mixed', { departure, breaks }),
    buildWeather('mixed', { departure, breaks }),
  );

test('stops sit between the checkpoints they fall between, and no checkpoint moves', () => {
  const route = planFor(true).routes[0];

  const items = interleave(route);

  const checkpoints = items.flatMap((item) => (item.kind === 'checkpoint' ? [item.cp] : []));
  expect(checkpoints.map((cp) => cp.index)).toEqual(route.checkpoints.map((cp) => cp.index));
  expect(items.filter((item) => item.kind === 'stop')).toHaveLength(route.stops.length);
  items.forEach((item, i) => {
    if (item.kind !== 'stop') return;
    const before = items
      .slice(0, i)
      .filter((x) => x.kind === 'checkpoint')
      .at(-1);
    const after = items.slice(i + 1).find((x) => x.kind === 'checkpoint');
    if (before?.kind === 'checkpoint')
      expect(before.cp.etaMs).toBeLessThanOrEqual(item.stop.startMs);
    if (after?.kind === 'checkpoint')
      expect(after.cp.etaMs).toBeGreaterThanOrEqual(stopEndMs(item.stop));
  });
});

test('a route with no stops lists exactly its checkpoints', () => {
  const route = planFor(false).routes[0];

  expect(interleave(route).every((item) => item.kind === 'checkpoint')).toBe(true);
  expect(interleave(route)).toHaveLength(route.checkpoints.length);
});

test('with breaks on the list shows each stop as a row, in time order, with the assumption', () => {
  const route = planFor(true).routes[0];
  render(
    <CheckpointList
      route={route}
      trip={trip}
      selected={null}
      selectedStop={null}
      onSelect={() => {}}
    />,
  );

  const rows = screen.getAllByRole('listitem');
  expect(rows).toHaveLength(route.checkpoints.length + route.stops.length);
  expect(screen.getAllByText(/^Break · mile \d+$/)).toHaveLength(1);
  expect(screen.getAllByText(/^Rest · mile \d+$/)).toHaveLength(1);
  expect(screen.getByText(/30 min break: .* to /)).toBeInTheDocument();
  expect(screen.getByText(/10 h rest: .* to /)).toBeInTheDocument();
  expect(screen.getByText(/rested start and no time except driving/)).toBeInTheDocument();
  // A stop carries the weather it sits in, like a checkpoint row: a level and the readings.
  const stopRow = screen.getByText(/^Rest · mile/).closest('li')!;
  expect(
    within(stopRow).getByText(/Low|Moderate|High|Severe|No Travel|No forecast/),
  ).toBeInTheDocument();
});

test('the selected stop is marked in the list', () => {
  const route = planFor(true).routes[0];
  render(
    <CheckpointList
      route={route}
      trip={trip}
      selected={null}
      selectedStop={{ routeId: route.id, index: 1 }}
      onSelect={() => {}}
    />,
  );

  const current = document.querySelectorAll('[aria-current="true"]');
  expect(current).toHaveLength(1);
  expect(current[0]).toHaveTextContent(/^Rest · mile/);
});

test('with breaks off the list has no stop rows and no break caption', () => {
  const route = planFor(false).routes[0];
  render(<CheckpointList route={route} trip={trip} selected={null} onSelect={() => {}} />);

  expect(screen.getAllByRole('listitem')).toHaveLength(route.checkpoints.length);
  expect(screen.queryByText(/Break · mile|Rest · mile/)).toBeNull();
  expect(screen.queryByText(/rested start/)).toBeNull();
});

test('the card headline is door-to-door time with the driving and break split beside it', () => {
  const view = planFor(true);
  const route = view.routes[0];
  render(
    <RouteCards
      routes={view.routes}
      trip={trip}
      selectedId={route.id}
      recommendedId={null}
      onSelect={() => {}}
    />,
  );

  expect(splitText(route)).toMatch(/^\d+ h( \d\d min)? driving \+ 10 h 30 min breaks$/);
  expect(document.body.textContent).toContain(
    `${formatDuration(route.travelSeconds)} · ${splitText(route)} · `,
  );
});

test('a trip that needs no stop says so when breaks are on, and says nothing about breaks when off', () => {
  const short = buildPlanView(buildRoutes('oneRoute', { departure, breaks: true }));
  const { rerender } = render(
    <RouteCards
      routes={short.routes}
      trip={trip}
      selectedId={null}
      recommendedId={null}
      onSelect={() => {}}
    />,
  );
  expect(screen.getByText(/no breaks needed/)).toBeInTheDocument();

  const off = planFor(false);
  rerender(
    <RouteCards
      routes={off.routes}
      trip={trip}
      selectedId={null}
      recommendedId={null}
      onSelect={() => {}}
    />,
  );
  expect(screen.queryByText(/driving \+|no breaks needed/)).toBeNull();
});

const planWith = (breaks: boolean, landed = true) => {
  const routes = buildRoutes('mixed', { departure, breaks });
  return buildPlanView(routes, landed ? buildWeather('mixed', { departure, breaks }) : undefined);
};
const listFor = (route: ReturnType<typeof planWith>['routes'][number]) =>
  render(
    <CheckpointList
      route={route}
      trip={trip}
      selected={null}
      selectedStop={null}
      onSelect={() => {}}
    />,
  );

test('a stop row shows the weather it sits in, with the hour that reading is for', () => {
  const route = planWith(true).routes[0];
  listFor(route);

  const rows = route.stops.map((stop) =>
    screen
      .getByText(new RegExp(`^${stop.kind === 'rest' ? 'Rest' : 'Break'} · mile`))
      .closest('li')!,
  );

  rows.forEach((row, i) => {
    const stop = route.stops[i];
    if (stop.risk.kind === 'level') {
      expect(within(row).getByText(/Wind \d+ mph/)).toBeInTheDocument();
      expect(within(row).getByText(/Worst during the stop, at /)).toBeInTheDocument();
    }
    expect(stop.risk.kind).not.toBe('pending');
  });
  expect(rows.some((row) => within(row).queryByText(/Low|Moderate|High|Severe|No Travel/))).toBe(
    true,
  );
});

test('a stop row says the weather is not in yet, and not Low, until it lands', () => {
  listFor(planWith(true, false).routes[0]);

  const row = screen.getByText(/^Rest · mile/).closest('li')!;

  expect(within(row).getByText('Checking weather')).toBeInTheDocument();
  expect(within(row).getByText('Weather not checked yet')).toBeInTheDocument();
  expect(within(row).queryByText('Low')).toBeNull();
  expect(within(row).queryByText(/Worst during the stop/)).toBeNull();
});

test('a stop the forecast does not reach says no forecast and shows no reading hour', () => {
  const routes = buildRoutes('mixed', { departure, breaks: true });
  const weather = buildWeather('mixed', { departure, breaks: true });
  weather.routes[0].stops = weather.routes[0].stops.map((s) => ({
    mile: s.mile,
    at: null,
    weather: null,
    risk: null,
  }));
  listFor(buildPlanView(routes, weather).routes[0]);

  const row = screen.getByText(/^Rest · mile/).closest('li')!;

  expect(within(row).getByText('No forecast')).toBeInTheDocument();
  expect(within(row).getByText('No forecast for this time')).toBeInTheDocument();
  expect(within(row).queryByText(/Worst during the stop/)).toBeNull();
});

test('with breaks off no stop row exists to carry weather', () => {
  render(
    <CheckpointList
      route={planWith(false).routes[0]}
      trip={trip}
      selected={null}
      onSelect={() => {}}
    />,
  );

  expect(screen.queryByText(/Worst during the stop/)).toBeNull();
  expect(screen.queryByText(/Rest · mile|Break · mile/)).toBeNull();
});

test('a stop is labelled with its length, a whole number of hours in hours', () => {
  const label = (kind: StopView['kind'], seconds: number) =>
    stopWhat({ kind, durationSeconds: seconds } as StopView);

  expect(label('break', 30 * 60)).toBe('30 min break');
  expect(label('rest', 10 * 3600)).toBe('10 h rest');
  expect(label('restart', 34 * 3600)).toBe('34 h restart');
});
