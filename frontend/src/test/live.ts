import type { RoutesOut, WeatherOut } from '../api/types';
import routesJson from './live/routes.json';
import weatherJson from './live/weather.json';

/**
 * One real routes and weather answer pair, as the endpoints returned them: Chicago to Salt Lake
 * City, 25-mile spacing, 36,000 lb, departing 2026-11-13 about 10:29 UTC. All Low apart from two
 * Moderate checkpoints, and the ranking is decided at travel time. It was captured before rest
 * breaks existed, so it is an off-mode answer: its routes carry `driving_seconds` equal to the
 * travel time, no stops, and the answer says breaks were not applied.
 */
export const LIVE_ROUTES = routesJson as unknown as RoutesOut;
export const LIVE_WEATHER = weatherJson as unknown as WeatherOut;
