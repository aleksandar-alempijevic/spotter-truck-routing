// Typed builders for the API's answers, used by the unit tests and by the stand-in server that
// the browser proof runs against. They import types only, so Node can run this file directly.
// Typing them against the generated wire types means contract drift fails `tsc`.
import type {
  CheckpointOut,
  ConditionsOut,
  GridOut,
  Level,
  RankingOut,
  RankingStep,
  RouteOut,
  RouteSummaryOut,
  RoutesOut,
  Spacing,
  SuggestionOut,
  WeatherCheckpointOut,
  WeatherOut,
  WeatherRouteOut,
} from '../api/types';

export type LatLon = readonly [number, number];

export const LEVEL_CODES: Level[] = ['low', 'moderate', 'high', 'severe', 'no_travel'];
const SCORE: Record<Level, number> = { low: 0, moderate: 1, high: 2, severe: 3, no_travel: 4 };

export const DALLAS: SuggestionOut = {
  label: 'Dallas, TX, United States',
  lat: 32.78,
  lon: -96.8,
  timezone: 'America/Chicago',
};

export type ScenarioKey = 'mixed' | 'tie' | 'shortfall' | 'oneRoute' | 'noneSafe';

interface ScenarioSpec {
  destination: SuggestionOut;
  /** One list of waypoints per route, fastest first, each starting at Dallas. */
  paths: LatLon[][];
  mph: number[];
  /** The level at checkpoint `index` of `count` on route `routeIndex`, or null for no forecast. */
  levelAt: (routeIndex: number, index: number, count: number) => Level | null;
  decidedBy: RankingStep | null;
  /** Route ids best first. */
  order: string[];
  recommended: string | null;
  shortfall: RoutesOut['shortfall'];
  /** Routes built through a via city, by index. */
  via?: Record<number, { name: string; lat: number; lon: number }>;
}

const place = (label: string, lat: number, lon: number): SuggestionOut => ({
  label: `${label}, United States`,
  lat,
  lon,
  timezone: 'America/Chicago',
});

const DENVER = place('Denver, CO', 39.74, -104.99);

const band = (i: number, count: number) => i / Math.max(count - 1, 1);

const SPECS: Record<ScenarioKey, ScenarioSpec> = {
  // Every non-Low level appears; route-3 has a no-forecast tail; route-2 wins at the Severe step.
  mixed: {
    destination: DENVER,
    paths: [
      [
        [32.78, -96.8],
        [35.22, -101.83],
        [39.74, -104.99],
      ],
      [
        [32.78, -96.8],
        [35.47, -97.52],
        [37.69, -97.34],
        [39.39, -101.05],
        [39.74, -104.99],
      ],
      [
        [32.78, -96.8],
        [33.58, -101.86],
        [35.08, -106.65],
        [36.0, -105.9],
        [39.74, -104.99],
      ],
    ],
    mph: [55, 52, 50],
    levelAt: (r, i, n) => {
      const t = band(i, n);
      if (r === 0)
        return t < 0.3
          ? 'low'
          : t < 0.5
            ? 'moderate'
            : t < 0.65
              ? 'severe'
              : t < 0.75
                ? 'no_travel'
                : 'high';
      if (r === 1) return t < 0.35 ? 'low' : t < 0.5 ? 'moderate' : t < 0.6 ? 'high' : 'low';
      return t > 0.8 ? null : t < 0.4 ? 'low' : t < 0.55 ? 'severe' : 'moderate';
    },
    decidedBy: 'severe',
    order: ['route-2', 'route-3', 'route-1'],
    recommended: 'route-2',
    shortfall: null,
    via: { 1: { name: 'Wichita', lat: 37.69, lon: -97.34 } },
  },
  // Same risk on all three routes, so travel time decides.
  tie: {
    destination: place('Oklahoma City, OK', 35.47, -97.52),
    paths: [
      [
        [32.78, -96.8],
        [35.47, -97.52],
      ],
      [
        [32.78, -96.8],
        [34.17, -97.14],
        [35.47, -97.52],
      ],
      [
        [32.78, -96.8],
        [33.91, -98.49],
        [35.47, -97.52],
      ],
    ],
    mph: [58, 55, 52],
    levelAt: (_r, i, n) => (band(i, n) > 0.4 && band(i, n) < 0.6 ? 'moderate' : 'low'),
    decidedBy: 'travel_time',
    order: ['route-1', 'route-2', 'route-3'],
    recommended: 'route-1',
    shortfall: null,
  },
  // Two routes and the server's note on why there is no third.
  shortfall: {
    destination: place('Amarillo, TX', 35.22, -101.83),
    paths: [
      [
        [32.78, -96.8],
        [33.91, -98.49],
        [35.22, -101.83],
      ],
      [
        [32.78, -96.8],
        [33.58, -101.86],
        [35.22, -101.83],
      ],
    ],
    mph: [55, 53],
    levelAt: (r, i, n) => (r === 0 && band(i, n) > 0.5 ? 'high' : 'low'),
    decidedBy: 'high',
    order: ['route-2', 'route-1'],
    recommended: 'route-2',
    shortfall: {
      reason: 'no_distinct_alternative',
      message:
        'Only two distinct routes were found: every other candidate, including a route through Oklahoma City, overlapped them by more than half.',
    },
  },
  // One route: no deciding step.
  oneRoute: {
    destination: place('Fort Worth, TX', 32.75, -97.33),
    paths: [
      [
        [32.78, -96.8],
        [32.75, -97.33],
      ],
    ],
    mph: [45],
    levelAt: () => 'low',
    decidedBy: null,
    order: ['route-1'],
    recommended: 'route-1',
    shortfall: {
      reason: 'no_distinct_alternative',
      message: 'This trip is short enough that only one sensible route exists.',
    },
  },
  // Every route has No Travel miles, so none is recommended.
  noneSafe: {
    destination: place('Wichita, KS', 37.69, -97.34),
    paths: [
      [
        [32.78, -96.8],
        [35.47, -97.52],
        [37.69, -97.34],
      ],
      [
        [32.78, -96.8],
        [34.6, -98.4],
        [37.69, -97.34],
      ],
    ],
    mph: [56, 54],
    levelAt: (r, i, n) => {
      const t = band(i, n);
      return t > 0.4 && t < 0.4 + (r === 0 ? 0.3 : 0.15) ? 'no_travel' : t > 0.7 ? 'high' : 'low';
    },
    decidedBy: 'no_travel',
    order: ['route-2', 'route-1'],
    recommended: null,
    shortfall: null,
  },
};

export const SCENARIO_KEYS = Object.keys(SPECS) as ScenarioKey[];
export const scenarioDestination = (key: ScenarioKey): SuggestionOut => SPECS[key].destination;

// ---------- geometry ----------

function miles([lat1, lon1]: LatLon, [lat2, lon2]: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

/** Vertices about every 5 miles along straight legs, with cumulative miles. */
function densify(path: LatLon[]): { points: LatLon[]; mile: number[] } {
  const points: LatLon[] = [path[0]];
  const mile = [0];
  for (let leg = 1; leg < path.length; leg++) {
    const from = path[leg - 1];
    const to = path[leg];
    const steps = Math.max(1, Math.round(miles(from, to) / 5));
    for (let s = 1; s <= steps; s++) {
      const next: LatLon = [
        from[0] + ((to[0] - from[0]) * s) / steps,
        from[1] + ((to[1] - from[1]) * s) / steps,
      ];
      mile.push(mile[mile.length - 1] + miles(points[points.length - 1], next));
      points.push(next);
    }
  }
  return { points, mile };
}

function pointAt(points: LatLon[], mile: number[], target: number): LatLon {
  let i = 1;
  while (i < mile.length - 1 && mile[i] < target) i++;
  const span = mile[i] - mile[i - 1] || 1;
  const f = Math.min(1, Math.max(0, (target - mile[i - 1]) / span));
  return [
    points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f,
    points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f,
  ];
}

const round = (n: number, places = 2) => Number(n.toFixed(places));

function buildRoute(
  spec: ScenarioSpec,
  index: number,
  spacing: Spacing,
  departureMs: number,
): { route: RouteOut; points: LatLon[] } {
  const { points, mile } = densify(spec.paths[index]);
  const total = mile[mile.length - 1];
  const marks: number[] = [];
  for (let m = 0; m < total; m += spacing) marks.push(m);
  marks.push(total);
  const speed = spec.mph[index];
  const checkpoints: CheckpointOut[] = marks.map((m) => {
    const [lat, lon] = pointAt(points, mile, m);
    return {
      mile: round(m),
      lat: round(lat, 5),
      lon: round(lon, 5),
      eta: new Date(departureMs + (m / speed) * 3_600_000).toISOString(),
    };
  });
  const via = spec.via?.[index] ?? null;
  return {
    points,
    route: {
      id: `route-${index + 1}`,
      travel_time_seconds: Math.round((total / speed) * 3600),
      total_miles: round(total),
      checkpoints,
      line: points.map(([lat, lon]) => [round(lon, 5), round(lat, 5)] as [number, number]),
      source: via ? 'via_city' : 'provider',
      via,
    },
  };
}

/** The routes answer for a scenario, as the server would return it for this trip. */
export function buildRoutes(
  key: ScenarioKey,
  options: { departure: string; spacing?: Spacing; loadLb?: number },
): RoutesOut {
  const spec = SPECS[key];
  const spacing = options.spacing ?? 25;
  const departureMs = Date.parse(options.departure);
  return {
    load_lb: options.loadLb ?? 36_000,
    checkpoint_interval_miles: spacing,
    routes: spec.paths.map((_, i) => buildRoute(spec, i, spacing, departureMs).route),
    shortfall: spec.shortfall,
  };
}

// ---------- weather ----------

const CONDITIONS: Record<Level, ConditionsOut> = {
  low: { wind_mph: 9, gust_mph: 15, rain_in_per_hr: 0, snow_in_per_hr: 0 },
  moderate: { wind_mph: 28, gust_mph: 39, rain_in_per_hr: 0, snow_in_per_hr: 0 },
  high: { wind_mph: 14, gust_mph: 22, rain_in_per_hr: 0.35, snow_in_per_hr: 0 },
  severe: { wind_mph: 20, gust_mph: 31, rain_in_per_hr: 0, snow_in_per_hr: 2.4 },
  no_travel: { wind_mph: 58, gust_mph: 71, rain_in_per_hr: 0.2, snow_in_per_hr: 0 },
};
const DECIDING: Record<Level, 'wind' | 'rain' | 'snow' | null> = {
  low: null,
  moderate: 'wind',
  high: 'rain',
  severe: 'snow',
  no_travel: 'wind',
};

function weatherCheckpoint(
  mile: number,
  level: Level | null,
  loadRaised: boolean,
): WeatherCheckpointOut {
  if (level === null) return { mile, weather: null, risk: null };
  // A load rule raises a High wind to Severe: 38 mph is High for a light load.
  const weather = loadRaised
    ? { wind_mph: 38, gust_mph: 47, rain_in_per_hr: 0, snow_in_per_hr: 0 }
    : CONDITIONS[level];
  return {
    mile,
    weather,
    risk: { level, condition: loadRaised ? 'wind' : DECIDING[level], load_raised: loadRaised },
  };
}

function summarize(route: RouteOut, checkpoints: WeatherCheckpointOut[]): RouteSummaryOut {
  const miles: Record<Level | 'none', number> = {
    low: 0,
    moderate: 0,
    high: 0,
    severe: 0,
    no_travel: 0,
    none: 0,
  };
  let weighted = 0;
  checkpoints.forEach((cp, i) => {
    const end = i + 1 < checkpoints.length ? checkpoints[i + 1].mile : route.total_miles;
    const span = end - cp.mile;
    if (cp.risk === null) miles.none += span;
    else {
      miles[cp.risk.level] += span;
      weighted += span * SCORE[cp.risk.level];
    }
  });
  const forecast = route.total_miles - miles.none;
  return {
    low_miles: round(miles.low),
    moderate_miles: round(miles.moderate),
    high_miles: round(miles.high),
    severe_miles: round(miles.severe),
    no_travel_miles: round(miles.no_travel),
    no_forecast_miles: round(miles.none),
    average_risk: forecast > 0 ? round(weighted / forecast, 4) : null,
  };
}

function buildRanking(
  spec: ScenarioSpec,
  routes: RouteOut[],
  summaries: Map<string, RouteSummaryOut>,
): RankingOut {
  const first = routes.find((r) => r.id === spec.order[0])!;
  const firstSummary = summaries.get(first.id)!;
  return {
    recommended_id: spec.recommended,
    decided_by: spec.decidedBy,
    routes: spec.order.map((id, i) => {
      const route = routes.find((r) => r.id === id)!;
      const summary = summaries.get(id)!;
      return {
        id,
        rank: i + 1,
        no_forecast_miles: summary.no_forecast_miles,
        average_risk_tolerance: summary.average_risk === null ? null : 0.05,
        vs_first:
          i === 0
            ? null
            : {
                dropped_at: spec.decidedBy ?? 'route_id',
                dropped_against: {
                  best_route_id: first.id,
                  route_value: summary.severe_miles,
                  best_value: firstSummary.severe_miles,
                  tolerance: 0,
                },
                travel_time_seconds: route.travel_time_seconds - first.travel_time_seconds,
                no_travel_miles: round(summary.no_travel_miles - firstSummary.no_travel_miles),
                severe_miles: round(summary.severe_miles - firstSummary.severe_miles),
                high_miles: round(summary.high_miles - firstSummary.high_miles),
                average_risk:
                  summary.average_risk === null || firstSummary.average_risk === null
                    ? null
                    : round(summary.average_risk - firstSummary.average_risk, 4),
              },
      };
    }),
  };
}

/** A 49-hour corridor grid: a storm drifting east, with no forecast in the last hours of the far cells. */
function buildGrid(
  linePoints: LatLon[][],
  departureMs: number,
  levelCodes: Level[],
  hours = 49,
): GridOut {
  const size = 0.5;
  const centres = new Map<string, LatLon>();
  for (const points of linePoints) {
    for (const [lat, lon] of points) {
      const c: LatLon = [
        Math.floor(lat / size) * size + size / 2,
        Math.floor(lon / size) * size + size / 2,
      ];
      centres.set(`${c[0]}|${c[1]}`, c);
    }
  }
  const startMs = Math.floor(departureMs / 3_600_000) * 3_600_000;
  const cells = [...centres.values()].map(([lat, lon]) => ({
    lat,
    lon,
    levels: Array.from({ length: hours }, (_, h): number | null => {
      if (lon > -99 && h >= 40) return null;
      const centre = -106 + 0.55 * h;
      const intensity = Math.max(0, 1 - Math.abs(lon - centre) / 3.2) * (lat > 34 ? 1 : 0.55);
      const level: Level =
        intensity > 0.85
          ? 'no_travel'
          : intensity > 0.65
            ? 'severe'
            : intensity > 0.45
              ? 'high'
              : intensity > 0.2
                ? 'moderate'
                : 'low';
      return levelCodes.indexOf(level);
    }),
  }));
  return {
    start: new Date(startMs).toISOString(),
    cell_degrees: size,
    level_codes: levelCodes,
    cells,
  };
}

export function buildWeather(
  key: ScenarioKey,
  options: { departure: string; spacing?: Spacing; loadLb?: number; levelCodes?: Level[] },
): WeatherOut {
  const spec = SPECS[key];
  const spacing = options.spacing ?? 25;
  const departureMs = Date.parse(options.departure);
  const built = spec.paths.map((_, i) => buildRoute(spec, i, spacing, departureMs));
  const summaries = new Map<string, RouteSummaryOut>();
  const routes: WeatherRouteOut[] = built.map(({ route }, r) => {
    const count = route.checkpoints.length;
    const checkpoints = route.checkpoints.map((cp, i) => {
      const level = spec.levelAt(r, i, count);
      // One High wind checkpoint on the first route is raised to Severe by the load.
      const raised = key === 'mixed' && r === 0 && i === Math.floor(count * 0.52);
      return weatherCheckpoint(cp.mile, raised ? 'severe' : level, raised);
    });
    const summary = summarize(route, checkpoints);
    summaries.set(route.id, summary);
    return { id: route.id, checkpoints, summary };
  });
  return {
    plan: { load_lb: options.loadLb ?? 36_000, checkpoint_interval_miles: spacing },
    departure: new Date(departureMs).toISOString(),
    routes,
    ranking: buildRanking(
      spec,
      built.map((b) => b.route),
      summaries,
    ),
    grid: buildGrid(
      built.map((b) => b.points),
      departureMs,
      options.levelCodes ?? LEVEL_CODES,
    ),
    attribution: { text: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' },
  };
}

export const ADDRESS_ATTRIBUTION = {
  text: 'Powered by Geoapify',
  url: 'https://www.geoapify.com/',
};

/** The suggestions a typed query returns in the stand-in. */
export function suggestionsFor(text: string): SuggestionOut[] {
  const q = text.trim().toLowerCase();
  const all = [DALLAS, ...SCENARIO_KEYS.map(scenarioDestination)];
  return all.filter((s) => s.label.toLowerCase().includes(q));
}
