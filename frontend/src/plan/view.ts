import { ApiError } from '../api/client';
import type {
  ConditionsOut,
  RankingOut,
  RouteSummaryOut,
  RoutesOut,
  WeatherOut,
} from '../api/types';
import { worstRisk, type RiskState } from '../risk/levels';

/** One checkpoint of one route, by route id and index: what the map and the panel select. */
export interface CheckpointRef {
  routeId: string;
  index: number;
}

export interface CheckpointView {
  index: number;
  mile: number;
  lat: number;
  lon: number;
  etaMs: number;
  risk: RiskState;
  conditions: ConditionsOut | null;
}

export interface RouteView {
  id: string;
  /** "Route 2". */
  name: string;
  /** The via city of a route built through one. */
  via: string | null;
  travelSeconds: number;
  miles: number;
  line: [number, number][];
  checkpoints: CheckpointView[];
  /** The worst level on the route, or pending / no forecast when it has none. */
  risk: RiskState;
  /** Null until the weather lands. */
  summary: RouteSummaryOut | null;
  rank: number | null;
  isFastest: boolean;
}

export interface PlanView {
  routes: RouteView[];
  /** The server's note on why there are fewer than three routes, verbatim. */
  shortfall: string | null;
  ranking: RankingOut | null;
  weatherReady: boolean;
  /** The weather request failed: checkpoints without weather read as unavailable, not pending. */
  weatherFailed: boolean;
}

/** The weather answer does not line up with the routes it was requested for. */
export function checkAligned(routes: RoutesOut, weather: WeatherOut): void {
  const bad = (what: string) => {
    throw new ApiError('unknown', `The weather answer does not match the routes (${what}).`, 200);
  };
  if (weather.routes.length !== routes.routes.length) bad('route count');
  const byId = new Map(weather.routes.map((r) => [r.id, r]));
  if (byId.size !== weather.routes.length) bad('duplicate route id');
  for (const route of routes.routes) {
    const w = byId.get(route.id);
    if (!w) bad(`missing ${route.id}`);
    else if (w.checkpoints.length !== route.checkpoints.length) bad(`${route.id} checkpoint count`);
  }
  const known = new Set(routes.routes.map((r) => r.id));
  if (weather.ranking.recommended_id !== null && !known.has(weather.ranking.recommended_id)) {
    bad('recommended route');
  }
  if (weather.ranking.routes.some((r) => !known.has(r.id))) bad('ranked route');
}

/** Joins the routes answer with the weather answer, by route id and checkpoint index. */
export function buildPlanView(
  routes: RoutesOut,
  weather?: WeatherOut,
  weatherFailed = false,
): PlanView {
  const weatherById = new Map(weather?.routes.map((r) => [r.id, r]));
  const rankById = new Map(weather?.ranking.routes.map((r) => [r.id, r.rank]));

  let fastest = routes.routes[0];
  for (const route of routes.routes) {
    if (route.travel_time_seconds < fastest.travel_time_seconds) fastest = route;
  }

  return {
    routes: routes.routes.map((route, routeIndex) => {
      const w = weatherById.get(route.id);
      const checkpoints: CheckpointView[] = route.checkpoints.map((cp, index) => {
        const wc = w?.checkpoints[index];
        const risk: RiskState = !wc
          ? { kind: weatherFailed ? 'unavailable' : 'pending' }
          : wc.risk
            ? {
                kind: 'level',
                level: wc.risk.level,
                condition: wc.risk.condition,
                loadRaised: wc.risk.load_raised,
              }
            : { kind: 'none' };
        return {
          index,
          mile: cp.mile,
          lat: cp.lat,
          lon: cp.lon,
          etaMs: Date.parse(cp.eta),
          risk,
          conditions: wc?.weather ?? null,
        };
      });
      return {
        id: route.id,
        name: `Route ${routeIndex + 1}`,
        via: route.via?.name ?? null,
        travelSeconds: route.travel_time_seconds,
        miles: route.total_miles,
        line: route.line,
        checkpoints,
        risk: worstRisk(checkpoints.map((cp) => cp.risk)),
        summary: w?.summary ?? null,
        rank: rankById.get(route.id) ?? null,
        isFastest: route.id === fastest.id,
      };
    }),
    shortfall: routes.shortfall?.message ?? null,
    ranking: weather?.ranking ?? null,
    weatherReady: weather !== undefined,
    weatherFailed,
  };
}
