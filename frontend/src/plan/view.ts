import { ApiError } from '../api/client';
import type {
  ConditionsOut,
  StopOut,
  RankingOut,
  RiskOut,
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

/**
 * A required stop on a route, as the server placed it; it ends at `stopEndMs`. Stops are a list of their own, never part
 * of `checkpoints`: a checkpoint's index is how the weather answer is joined to its route.
 */
export interface StopView {
  /** Position in the route's stop list: with the route id, what a tap on a stop selects. */
  index: number;
  kind: StopOut['kind'];
  mile: number;
  lat: number;
  lon: number;
  startMs: number;
  durationSeconds: number;
  /**
   * The weather a parked truck sits in: the worst the forecast gives over the stop. Read exactly
   * as a checkpoint's is, and kept out of the route's risk and summary.
   */
  risk: RiskState;
  conditions: ConditionsOut | null;
  /** The instant within the stop that the reading is for; null without a forecast. */
  readAtMs: number | null;
}

/** One stop of one route, by route id and index in its stop list. */
export interface StopRef {
  routeId: string;
  index: number;
}

export interface RouteView {
  id: string;
  /** "Route 2". */
  name: string;
  /** The via city of a route built through one. */
  via: string | null;
  /** Departure to arrival: includes the stops when the plan was made with rest breaks. */
  travelSeconds: number;
  /** Time at the wheel; equals `travelSeconds` when the plan has no rest breaks. */
  drivingSeconds: number;
  stops: StopView[];
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
  /** Whether the times include the rest breaks, as the routes answer says it was made. */
  breaksApplied: boolean;
  /** The server's note on why there are fewer than three routes, verbatim. */
  shortfall: string | null;
  ranking: RankingOut | null;
  /**
   * Where the weather stands: not yet in, in, or failed. A failure wins over data left from an
   * earlier answer, and checkpoints without weather then read as unavailable, not pending.
   */
  weather: WeatherState;
}

type WeatherState = 'pending' | 'ready' | 'failed';

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
    else if (w.stops.length !== route.stops.length) bad(`${route.id} stop count`);
  }
  const known = new Set(routes.routes.map((r) => r.id));
  if (weather.ranking.recommended_id !== null && !known.has(weather.ranking.recommended_id)) {
    bad('recommended route');
  }
  if (weather.ranking.routes.some((r) => !known.has(r.id))) bad('ranked route');
}

/** A reading's risk: not in yet, unavailable after a failure, none without a forecast, or a level. */
function riskOf(
  risk: RiskOut | null | undefined,
  missing: boolean,
  weatherFailed: boolean,
): RiskState {
  if (missing) return { kind: weatherFailed ? 'unavailable' : 'pending' };
  if (!risk) return { kind: 'none' };
  return {
    kind: 'level',
    level: risk.level,
    condition: risk.condition,
    loadRaised: risk.load_raised,
  };
}

/** Joins the routes answer with the weather answer, by route id and checkpoint index. */
export function buildPlanView(
  routes: RoutesOut,
  weather?: WeatherOut,
  weatherFailed = false,
): PlanView {
  const weatherState: WeatherState = weatherFailed ? 'failed' : weather ? 'ready' : 'pending';
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
        const risk = riskOf(wc?.risk, !wc, weatherFailed);
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
        drivingSeconds: route.driving_seconds,
        stops: route.stops.map((stop, index) => {
          const ws = w?.stops[index];
          return {
            index,
            kind: stop.kind,
            mile: stop.mile,
            lat: stop.lat,
            lon: stop.lon,
            startMs: Date.parse(stop.starts_at),
            durationSeconds: stop.duration_seconds,
            risk: riskOf(ws?.risk, !ws, weatherFailed),
            conditions: ws?.weather ?? null,
            readAtMs: ws?.at ? Date.parse(ws.at) : null,
          };
        }),
        miles: route.total_miles,
        line: route.line,
        checkpoints,
        risk: worstRisk(checkpoints.map((cp) => cp.risk)),
        summary: w?.summary ?? null,
        rank: rankById.get(route.id) ?? null,
        isFastest: route.id === fastest.id,
      };
    }),
    breaksApplied: routes.breaks_applied,
    shortfall: routes.shortfall?.message ?? null,
    ranking: weather?.ranking ?? null,
    weather: weatherState,
  };
}
