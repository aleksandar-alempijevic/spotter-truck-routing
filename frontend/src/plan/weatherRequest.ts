import type { RoutesOut, WeatherIn } from '../api/types';

/** The weather request is the routes answer's send-back subset: no line, source, via or shortfall. */
export function buildWeatherBody(routes: RoutesOut): WeatherIn {
  return {
    load_lb: routes.load_lb,
    checkpoint_interval_miles: routes.checkpoint_interval_miles,
    routes: routes.routes.map((route) => ({
      id: route.id,
      travel_time_seconds: route.travel_time_seconds,
      total_miles: route.total_miles,
      checkpoints: route.checkpoints,
    })),
  };
}
