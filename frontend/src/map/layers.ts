import type { ExpressionSpecification } from 'maplibre-gl';
import type { Level } from '../api/types';
import { cellFill } from '../risk/levels';
import { NO_FORECAST } from '../timeline/grid';

export const SOURCE = {
  routes: 'routes',
  checkpoints: 'checkpoints',
  grid: 'grid-cells',
  endpoints: 'endpoints',
  selected: 'selected-checkpoint',
  trucks: 'trucks',
  stops: 'stops',
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
  stops: 'stops',
} as const;

export const ICON_PREFIX = 'risk-';
export const HATCH_IMAGE = 'no-forecast-hatch';
export const STOP_IMAGE = 'stop-mark';

/** The level a cell shows: the hour's diff as feature state, else the level it was built with. */
const cellLevel: ExpressionSpecification = ['coalesce', ['feature-state', 'level'], ['get', 'l']];

/** Colour of a heatmap cell by level index, resolved through the answer's `level_codes`. */
export function gridFillColor(levelNames: readonly Level[]): ExpressionSpecification {
  const branches = levelNames.flatMap((name, index) => [index, cellFill(name)]);
  return ['match', cellLevel, ...branches, 'rgba(0,0,0,0)'] as ExpressionSpecification;
}

/** Cells with no forecast get a hatch, so "no forecast" never looks like a risk colour. */
export const gridNoForecastOpacity: ExpressionSpecification = [
  'case',
  ['==', cellLevel, NO_FORECAST],
  0.8,
  0,
];

/** The map's own colours, outside the risk palette. */
export const MAP_COLORS = {
  route: '#5f7a91',
  routeSelected: '#0d47a1',
  routeCasing: '#ffffff',
  truck: '#212121',
  origin: '#1b5e20',
  destination: '#0d47a1',
  ring: '#0d47a1',
} as const;

/** An expression that is `yes` for features whose `key` property is the selected route, else `no`. */
const ifSelected = <T extends number | string>(
  key: 'id' | 'routeId',
  selectedId: string | null,
  yes: T,
  no: T,
): ExpressionSpecification => ['case', ['==', ['get', key], selectedId ?? ''], yes, no];

export const routeColor = (selectedId: string | null) =>
  ifSelected('id', selectedId, MAP_COLORS.routeSelected, MAP_COLORS.route);

export const routeWidth = (selectedId: string | null, selected: number, other: number) =>
  ifSelected('id', selectedId, selected, other);

/** Line widths of the route and its casing: the selected route, then the others. */
export const ROUTE_WIDTH = { line: [6, 4], casing: [10, 7] } as const;

export const checkpointIconSize = (selectedId: string | null) =>
  ifSelected('routeId', selectedId, 0.85, 0.5);

export const checkpointSortKey = (selectedId: string | null) =>
  ifSelected('routeId', selectedId, 1, 0);

export const truckRadius = (selectedId: string | null) => ifSelected('routeId', selectedId, 12, 9);
