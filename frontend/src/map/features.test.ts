import { expect, test } from 'vitest';
import { buildPlanView } from '../plan/view';
import { buildRoutes, buildWeather, LEVEL_CODES } from '../test/fixtures';
import { buildGridModel } from '../timeline/grid';
import {
  checkpointPoints,
  endpointPoints,
  gridCells,
  routeBounds,
  routeLines,
  selectedPoint,
  truckPoints,
} from './features';
import { gridFillColor } from './layers';

const departure = '2026-11-20T14:00:00Z';
const routes = buildRoutes('mixed', { departure });
const weather = buildWeather('mixed', { departure });
const pending = buildPlanView(routes);
const ready = buildPlanView(routes, weather);

test('there is one line feature per route, so a later change can colour it by segment', () => {
  const lines = routeLines(ready.routes);
  expect(lines.features.map((f) => f.properties.id)).toEqual(['route-1', 'route-2', 'route-3']);
  expect(lines.features[0].geometry.coordinates).toEqual(routes.routes[0].line);
});

test('every checkpoint of every route is a mark, carrying its glyph key', () => {
  const total = routes.routes.reduce((n, r) => n + r.checkpoints.length, 0);
  const points = checkpointPoints(ready.routes);
  expect(points.features).toHaveLength(total);
  const icons = new Set(points.features.map((f) => f.properties.icon));
  expect(icons).toEqual(new Set([...LEVEL_CODES, 'none']));
  expect(new Set(checkpointPoints(pending.routes).features.map((f) => f.properties.icon))).toEqual(
    new Set(['pending']),
  );
});

test('the grid squares come from each centre and cell size, with the index as the id', () => {
  const model = buildGridModel(weather.grid, weather.departure);
  const cells = gridCells(model, 0);
  expect(cells.features).toHaveLength(model.cellCount);
  const f = cells.features[3];
  expect(f.id).toBe(3);
  const ring = f.geometry.coordinates[0];
  expect(ring).toHaveLength(5);
  expect(ring[0]).toEqual([model.cellLon[3] - 0.25, model.cellLat[3] - 0.25]);
  expect(ring[2]).toEqual([model.cellLon[3] + 0.25, model.cellLat[3] + 0.25]);
});

test('a cell with no forecast carries -1, not a level', () => {
  const model = buildGridModel(weather.grid, weather.departure);
  const late = gridCells(model, 45).features.map((f) => f.properties.l);
  expect(late).toContain(-1);
});

test('endpoints are the first line vertex and the last', () => {
  const [origin, destination] = endpointPoints(ready.routes).features;
  expect(origin.properties.kind).toBe('origin');
  expect(origin.geometry.coordinates).toEqual(routes.routes[0].line[0]);
  expect(destination.geometry.coordinates).toEqual(routes.routes[0].line.at(-1));
});

test('bounds cover every route; no routes, no bounds', () => {
  const [[w, s], [e, n]] = routeBounds(ready.routes)!;
  expect(w).toBeLessThan(e);
  expect(s).toBeLessThan(n);
  for (const r of routes.routes)
    for (const [lon, lat] of r.line) {
      expect(lon).toBeGreaterThanOrEqual(w);
      expect(lat).toBeLessThanOrEqual(n);
    }
  expect(routeBounds([])).toBeNull();
});

test('the selected checkpoint is one point; nothing selected is empty', () => {
  expect(selectedPoint(ready.routes, 'route-2', 4).features).toHaveLength(1);
  expect(selectedPoint(ready.routes, null, null).features).toHaveLength(0);
  expect(selectedPoint(ready.routes, 'route-2', 9999).features).toHaveLength(0);
});

test('the heatmap colours follow level_codes, not severity order', () => {
  const permuted = ['severe', 'low', 'moderate', 'high', 'no_travel'] as const;
  const expr = gridFillColor(permuted) as unknown[];
  expect(expr[0]).toBe('match');
  // index 0 is severe's colour, index 1 is low's
  expect(String(expr[3])).toMatch(/211,47,47/);
  expect(String(expr[5])).toMatch(/157,184,166/);
});

test('only trucks on the road are marked', () => {
  const truck = (routeId: string, status: 'before' | 'driving' | 'arrived') => ({
    routeId,
    name: routeId,
    status,
    mile: 1,
    position: [-100, 40] as [number, number],
  });
  const marks = truckPoints([truck('a', 'before'), truck('b', 'driving'), truck('c', 'arrived')]);
  expect(marks.features.map((f) => f.properties.routeId)).toEqual(['b']);
  expect(marks.features[0].geometry.coordinates).toEqual([-100, 40]);
});
