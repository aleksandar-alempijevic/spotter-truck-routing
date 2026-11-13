import type { RoutesOut, WeatherOut } from '../api/types';
import routesJson from './live/routes.json';
import weatherJson from './live/weather.json';

/**
 * One real routes and weather answer pair, as the endpoints returned them: Chicago to Salt Lake
 * City, 25-mile spacing, 36,000 lb, departing 2026-11-13 about 10:29 UTC. All Low apart from two
 * Moderate checkpoints, and the ranking is decided at travel time.
 */
export const LIVE_ROUTES = routesJson as unknown as RoutesOut;
export const LIVE_WEATHER = weatherJson as unknown as WeatherOut;
