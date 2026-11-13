import type { GridOut, Level } from '../api/types';
import { HOUR_MS } from '../time/zone';

/** The level value of a cell with no forecast at that hour. */
export const NO_FORECAST = -1;

/** The corridor grid as flat numbers, ready for the map and the slider. */
export interface GridModel {
  cellCount: number;
  /** Read from the data; nothing assumes 49. */
  hourCount: number;
  /** `levels[cell * hourCount + hour]`: an index into `levelNames`, or `NO_FORECAST`. */
  levels: Int8Array;
  /** The level each index means, from the answer's `level_codes`. Index order is the server's. */
  levelNames: Level[];
  cellLat: Float64Array;
  cellLon: Float64Array;
  cellDegrees: number;
  /** The instant of hour 0. */
  startMs: number;
  /** The departure's position on the hour axis, fractional. */
  departureHour: number;
}

interface CellChange {
  cell: number;
  level: number;
}

export function buildGridModel(grid: GridOut, departureIso: string): GridModel {
  const cellCount = grid.cells.length;
  const hourCount = grid.cells.reduce((most, cell) => Math.max(most, cell.levels.length), 0);
  const levels = new Int8Array(cellCount * hourCount).fill(NO_FORECAST);
  const cellLat = new Float64Array(cellCount);
  const cellLon = new Float64Array(cellCount);

  grid.cells.forEach((cell, c) => {
    cellLat[c] = cell.lat;
    cellLon[c] = cell.lon;
    cell.levels.forEach((value, h) => {
      const known = value !== null && value >= 0 && value < grid.level_codes.length;
      levels[c * hourCount + h] = known ? value : NO_FORECAST;
    });
  });

  const startMs = Date.parse(grid.start);
  return {
    cellCount,
    hourCount,
    levels,
    levelNames: [...grid.level_codes],
    cellLat,
    cellLon,
    cellDegrees: grid.cell_degrees,
    startMs,
    departureHour: (Date.parse(departureIso) - startMs) / HOUR_MS,
  };
}

export function levelAt(model: GridModel, cell: number, hour: number): number {
  if (hour < 0 || hour >= model.hourCount) return NO_FORECAST;
  return model.levels[cell * model.hourCount + hour];
}

export const hourInstant = (model: GridModel, hour: number): number =>
  model.startMs + hour * HOUR_MS;

/** The cells whose level differs between two hours, with their level at `to`. */
export function diffHours(model: GridModel, from: number, to: number): CellChange[] {
  if (from === to) return [];
  const changes: CellChange[] = [];
  for (let cell = 0; cell < model.cellCount; cell++) {
    const next = levelAt(model, cell, to);
    if (next !== levelAt(model, cell, from)) changes.push({ cell, level: next });
  }
  return changes;
}

/** The hour the slider starts on: the departure, kept inside the hours the data has. */
export function initialHour(model: GridModel): number {
  return Math.min(model.hourCount - 1, Math.max(0, Math.round(model.departureHour)));
}
