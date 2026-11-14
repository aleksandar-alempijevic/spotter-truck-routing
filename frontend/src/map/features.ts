// Pure feature building for the map layers. Nothing here imports maplibre-gl, so vitest covers it.
import type { RiskKey } from '../risk/levels';
import { riskKey } from '../risk/levels';
import { levelAt, type GridModel } from '../timeline/grid';
import type { Truck } from '../timeline/trucks';
import type { RouteView } from '../plan/view';

interface Feature<G, P> {
  type: 'Feature';
  id?: number;
  geometry: G;
  properties: P;
}
interface FeatureCollection<G, P> {
  type: 'FeatureCollection';
  features: Feature<G, P>[];
}
type Point = { type: 'Point'; coordinates: [number, number] };
type LineString = { type: 'LineString'; coordinates: [number, number][] };
type Polygon = { type: 'Polygon'; coordinates: [number, number][][] };

export const emptyCollection = <G, P>(): FeatureCollection<G, P> => ({
  type: 'FeatureCollection',
  features: [],
});

/** One feature per route: the line stays one feature so a later change can colour it by segment. */
export function routeLines(
  routes: readonly RouteView[],
): FeatureCollection<LineString, { id: string }> {
  return {
    type: 'FeatureCollection',
    features: routes.map((route) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.line },
      properties: { id: route.id },
    })),
  };
}

interface CheckpointProps {
  routeId: string;
  index: number;
  /** Which glyph to draw: the level, "pending" or "none". */
  icon: RiskKey;
}

export function checkpointPoints(
  routes: readonly RouteView[],
): FeatureCollection<Point, CheckpointProps> {
  const features: FeatureCollection<Point, CheckpointProps>['features'] = [];
  for (const route of routes) {
    for (const cp of route.checkpoints) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [cp.lon, cp.lat] },
        properties: { routeId: route.id, index: cp.index, icon: riskKey(cp.risk) },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

interface StopProps {
  routeId: string;
  index: number;
  /** Which glyph to draw. */
  icon: 'stop';
}

/** The selected route's required stops, one point each. Other routes' stops are not drawn. */
export function stopPoints(
  routes: readonly RouteView[],
  selectedRouteId: string | null,
): FeatureCollection<Point, StopProps> {
  const route = routes.find((r) => r.id === selectedRouteId);
  return {
    type: 'FeatureCollection',
    features: (route?.stops ?? []).map((stop) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
      properties: { routeId: route!.id, index: stop.index, icon: 'stop' },
    })),
  };
}

export function endpointPoints(
  routes: readonly RouteView[],
): FeatureCollection<Point, { kind: 'origin' | 'destination' }> {
  const line = routes[0]?.line;
  if (!line || line.length === 0) return emptyCollection();
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: line[0] },
        properties: { kind: 'origin' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: line[line.length - 1] },
        properties: { kind: 'destination' },
      },
    ],
  };
}

export function selectedPoint(
  routes: readonly RouteView[],
  routeId: string | null,
  index: number | null,
): FeatureCollection<Point, Record<string, never>> {
  const cp = routes.find((r) => r.id === routeId)?.checkpoints[index ?? -1];
  if (!cp) return emptyCollection();
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [cp.lon, cp.lat] },
        properties: {},
      },
    ],
  };
}

/**
 * The corridor's squares. A cell's index is its feature id, so the slider can address it. `l`
 * is the level at `hour`; later hours are applied as feature state from the diff.
 */
export function gridCells(
  model: GridModel,
  hour: number,
): FeatureCollection<Polygon, { l: number }> {
  const half = model.cellDegrees / 2;
  const features: FeatureCollection<Polygon, { l: number }>['features'] = [];
  for (let cell = 0; cell < model.cellCount; cell++) {
    const lat = model.cellLat[cell];
    const lon = model.cellLon[cell];
    features.push({
      type: 'Feature',
      id: cell,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [lon - half, lat - half],
            [lon + half, lat - half],
            [lon + half, lat + half],
            [lon - half, lat + half],
            [lon - half, lat - half],
          ],
        ],
      },
      properties: { l: levelAt(model, cell, hour) },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** West, south, east, north of every route line, or null with no routes. */
export function routeBounds(
  routes: readonly RouteView[],
): [[number, number], [number, number]] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const route of routes) {
    for (const [lon, lat] of route.line) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return Number.isFinite(west)
    ? [
        [west, south],
        [east, north],
      ]
    : null;
}

/** The trucks that are on the road: one point each. A truck not yet left or already arrived has none. */
export function truckPoints(
  trucks: readonly Truck[],
): FeatureCollection<Point, { routeId: string }> {
  return {
    type: 'FeatureCollection',
    features: trucks
      .filter((truck) => truck.status === 'driving')
      .map((truck) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: truck.position },
        properties: { routeId: truck.routeId },
      })),
  };
}
