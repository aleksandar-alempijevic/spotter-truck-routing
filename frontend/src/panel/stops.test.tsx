import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { Trip } from '../plan/trip';
import { buildPlanView } from '../plan/view';
import { buildRoutes, buildWeather, DALLAS, scenarioDestination } from '../test/fixtures';
import { formatDuration } from '../time/zone';
import { CheckpointList } from './CheckpointList';
import { RouteCards } from './RouteCards';
import { interleave, splitText } from './stops';

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
      expect(after.cp.etaMs).toBeGreaterThanOrEqual(item.stop.endMs);
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
      breaksApplied
      onSelect={() => {}}
    />,
  );

  const rows = screen.getAllByRole('listitem');
  expect(rows).toHaveLength(route.checkpoints.length + route.stops.length);
  expect(screen.getAllByText(/^Break · mile \d+$/)).toHaveLength(1);
  expect(screen.getAllByText(/^Rest · mile \d+$/)).toHaveLength(1);
  expect(screen.getByText(/30-minute break: .* to /)).toBeInTheDocument();
  expect(screen.getByText(/10-hour rest: .* to /)).toBeInTheDocument();
  expect(screen.getByText(/rested start and no time except driving/)).toBeInTheDocument();
  // A stop has no risk badge: the row carries no level.
  const stopRow = screen.getByText(/^Rest · mile/).closest('li')!;
  expect(within(stopRow).queryByText(/Low|Moderate|High|Severe|No Travel/)).toBeNull();
});

test('the selected stop is marked in the list', () => {
  const route = planFor(true).routes[0];
  render(
    <CheckpointList
      route={route}
      trip={trip}
      selected={null}
      selectedStop={{ routeId: route.id, index: 1 }}
      breaksApplied
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
      breaksApplied
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
      breaksApplied
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
