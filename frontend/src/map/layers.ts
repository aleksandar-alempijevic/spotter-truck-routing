import type { ExpressionSpecification } from 'maplibre-gl';
import type { Level } from '../api/types';
import { RISK_STYLE } from '../risk/levels';
import { NO_FORECAST } from '../timeline/grid';

export const SOURCE = {
  routes: 'routes',
  checkpoints: 'checkpoints',
  grid: 'grid-cells',
  endpoints: 'endpoints',
  selected: 'selected-checkpoint',
  trucks: 'trucks',
} as const;

export const LAYER = {
  gridFill: 'grid-fill',
  gridNoForecast: 'grid-no-forecast',
  routeCasing: 'route-casing',
  routeLine: 'route-line',
  checkpoints: 'checkpoints',
  selectedRing: 'selected-checkpoint-ring',
  endpoints: 'endpoints',
  trucks: 'trucks',
} as const;

export const ICON_PREFIX = 'risk-';
export const HATCH_IMAGE = 'no-forecast-hatch';

/** The level a cell shows: the hour's diff as feature state, else the level it was built with. */
const cellLevel: ExpressionSpecification = ['coalesce', ['feature-state', 'level'], ['get', 'l']];

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Colour of a heatmap cell by level index, resolved through the answer's `level_codes`. */
export function gridFillColor(levelNames: readonly Level[]): ExpressionSpecification {
  const branches = levelNames.flatMap((name, index) => [
    index,
    withAlpha(RISK_STYLE[name].color, name === 'low' ? 0.22 : 0.62),
  ]);
  return ['match', cellLevel, ...branches, 'rgba(0,0,0,0)'] as ExpressionSpecification;
}

/** Cells with no forecast get a hatch, so "no forecast" never looks like a risk colour. */
export const gridNoForecastOpacity: ExpressionSpecification = [
  'case',
  ['==', cellLevel, NO_FORECAST],
  0.8,
  0,
];

export const routeColor = (selectedId: string | null): ExpressionSpecification => [
  'case',
  ['==', ['get', 'id'], selectedId ?? ''],
  '#0d47a1',
  '#5f7a91',
];

export const routeWidth = (
  selectedId: string | null,
  selected: number,
  other: number,
): ExpressionSpecification => ['case', ['==', ['get', 'id'], selectedId ?? ''], selected, other];

export const checkpointIconSize = (selectedId: string | null): ExpressionSpecification => [
  'case',
  ['==', ['get', 'routeId'], selectedId ?? ''],
  0.85,
  0.5,
];

export const checkpointSortKey = (selectedId: string | null): ExpressionSpecification => [
  'case',
  ['==', ['get', 'routeId'], selectedId ?? ''],
  1,
  0,
];

export const truckRadius = (selectedId: string | null): ExpressionSpecification => [
  'case',
  ['==', ['get', 'routeId'], selectedId ?? ''],
  12,
  9,
];
