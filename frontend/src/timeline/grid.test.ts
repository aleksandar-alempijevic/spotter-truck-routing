import { expect, test } from 'vitest';
import type { GridOut } from '../api/types';
import { buildWeather, LEVEL_CODES } from '../test/fixtures';
import { buildGridModel, diffHours, hourInstant, initialHour, levelAt, NO_FORECAST } from './grid';

const grid: GridOut = {
  start: '2026-11-20T14:00:00Z',
  cell_degrees: 0.5,
  // Deliberately not in severity order: index must not be read as severity.
  level_codes: ['severe', 'low', 'moderate'],
  cells: [
    { lat: 35.25, lon: -97.25, levels: [1, 1, 2, 0, null] },
    { lat: 35.75, lon: -97.25, levels: [1, 1, 1, 1, 1] },
    { lat: 36.25, lon: -97.25, levels: [null, 1, 1, 2, 2] },
  ],
};

test('hour count comes from the data and levels resolve through level_codes', () => {
  const model = buildGridModel(grid, '2026-11-20T15:30:00Z');
  expect(model.hourCount).toBe(5);
  expect(model.cellCount).toBe(3);
  expect(model.levelNames[levelAt(model, 0, 3)]).toBe('severe');
  expect(model.levelNames[levelAt(model, 0, 0)]).toBe('low');
});

test('null is no forecast, never a level, and out of range reads the same', () => {
  const model = buildGridModel(grid, '2026-11-20T14:00:00Z');
  expect(levelAt(model, 0, 4)).toBe(NO_FORECAST);
  expect(levelAt(model, 2, 0)).toBe(NO_FORECAST);
  expect(levelAt(model, 0, 99)).toBe(NO_FORECAST);
  expect(levelAt(model, 0, -1)).toBe(NO_FORECAST);
});

test('a level index outside level_codes is treated as no forecast', () => {
  const odd: GridOut = { ...grid, cells: [{ lat: 1, lon: 1, levels: [7, 0] }] };
  expect(levelAt(buildGridModel(odd, grid.start), 0, 0)).toBe(NO_FORECAST);
});

test('the departure sits at a fractional hour from the grid start', () => {
  expect(buildGridModel(grid, '2026-11-20T15:30:00Z').departureHour).toBe(1.5);
  expect(hourInstant(buildGridModel(grid, grid.start), 3)).toBe(Date.parse('2026-11-20T17:00:00Z'));
});

test('the diff holds only cells whose level differs, with the new level', () => {
  const model = buildGridModel(grid, grid.start);
  expect(diffHours(model, 0, 1)).toEqual([{ cell: 2, level: levelAt(model, 2, 1) }]);
  expect(diffHours(model, 1, 2)).toEqual([{ cell: 0, level: levelAt(model, 0, 2) }]);
  expect(diffHours(model, 2, 2)).toEqual([]);
});

test('null to level, level to null, and the first and last hours are all diffs', () => {
  const model = buildGridModel(grid, grid.start);
  expect(diffHours(model, 3, 4)).toContainEqual({ cell: 0, level: NO_FORECAST });
  expect(diffHours(model, 0, 1)).toContainEqual({ cell: 2, level: levelAt(model, 2, 1) });
  // first hour to last: cell 0 goes low to no forecast, cell 2 goes no forecast to moderate
  expect(diffHours(model, 0, model.hourCount - 1).map((c) => c.cell)).toEqual([0, 2]);
});

test('a jump of several hours diffs against the hour on screen, not the hour before', () => {
  const model = buildGridModel(grid, grid.start);
  const jump = diffHours(model, 0, 3);
  expect(jump).toEqual([
    { cell: 0, level: levelAt(model, 0, 3) },
    { cell: 2, level: levelAt(model, 2, 3) },
  ]);
});

test('the whole fixture grid builds: 49 hours, null cells present, only a minority change per hour', () => {
  const weather = buildWeather('mixed', { departure: '2026-11-20T14:00:00Z' });
  const model = buildGridModel(weather.grid, weather.departure);
  expect(model.hourCount).toBe(49);
  expect(model.levelNames).toEqual(LEVEL_CODES);
  expect(model.levels.includes(NO_FORECAST)).toBe(true);
  const changed = diffHours(model, 20, 21).length;
  expect(changed).toBeGreaterThan(0);
  expect(changed).toBeLessThan(model.cellCount);
});

test('the slider starts on the departure hour, kept inside the data', () => {
  const weather = buildWeather('mixed', { departure: '2026-11-20T14:30:00Z' });
  const model = buildGridModel(weather.grid, weather.departure);
  expect(initialHour(model)).toBe(Math.round(model.departureHour));
  expect(initialHour({ ...model, departureHour: -5 })).toBe(0);
  expect(initialHour({ ...model, departureHour: 500 })).toBe(model.hourCount - 1);
});
