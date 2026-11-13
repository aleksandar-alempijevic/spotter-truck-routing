import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { asApiError, type ApiError } from '../api/client';
import { fetchRoutes, fetchWeather } from '../api/endpoints';
import type { RoutesOut, WeatherOut } from '../api/types';
import { NO_REFETCH } from './queryClient';
import { explain, type Explanation } from './explain';
import { buildRoutesBody, type Submission } from './trip';
import { buildPlanView, checkAligned, type PlanView } from './view';
import { buildWeatherBody } from './weatherRequest';

// Each planning request is made once per submission, and again only when the driver asks. The
// shared no-retry, no-refocus policy is spelled out here with the rest, not left to the client's
// defaults, because a slow routing call must never be repeated behind the driver's back: not on
// error, focus, reconnect or remount.
const ONCE = {
  ...NO_REFETCH,
  retryOnMount: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
  staleTime: Infinity,
} as const;

export type PlanPhase =
  'idle' | 'routes_pending' | 'routes_error' | 'weather_pending' | 'weather_error' | 'ready';

export interface PlanState {
  phase: PlanPhase;
  view: PlanView | null;
  explanation: Explanation | null;
  weather: WeatherOut | undefined;
  routesError: ApiError | null;
  weatherError: ApiError | null;
  /** When the routes answer landed, for the weather wait's elapsed time. */
  routesAt: number;
  retryRoutes: () => void;
  retryWeather: () => void;
}

async function weatherFor(routes: RoutesOut, signal: AbortSignal): Promise<WeatherOut> {
  const weather = await fetchWeather(buildWeatherBody(routes), signal);
  checkAligned(routes, weather);
  return weather;
}

/** The two planning queries for one submission: routes, then weather for those routes. */
export function usePlan(submission: Submission | null): PlanState {
  const id = submission?.id ?? 0;

  const routesQuery = useQuery({
    queryKey: ['routes', id],
    queryFn: ({ signal }) => fetchRoutes(buildRoutesBody(submission!.trip), signal),
    enabled: submission !== null,
    ...ONCE,
  });
  const routes = routesQuery.data;

  // The key carries the routes answer's own identity, so a weather answer can only be joined to
  // the routes whose send-back produced it.
  const weatherQuery = useQuery({
    queryKey: ['weather', id, routesQuery.dataUpdatedAt],
    queryFn: ({ signal }) => weatherFor(routes!, signal),
    enabled: routes !== undefined,
    ...ONCE,
  });
  const weather = weatherQuery.data;

  const weatherFailed = weatherQuery.isError;
  const view = useMemo(
    () => (routes ? buildPlanView(routes, weather, weatherFailed) : null),
    [routes, weather, weatherFailed],
  );
  const explanation = useMemo(
    () => (view && weather ? explain(weather.ranking, view.routes) : null),
    [view, weather],
  );

  const phase: PlanPhase =
    submission === null
      ? 'idle'
      : routesQuery.isError
        ? 'routes_error'
        : routes === undefined
          ? 'routes_pending'
          : weatherFailed
            ? 'weather_error'
            : weather === undefined
              ? 'weather_pending'
              : 'ready';

  return {
    phase,
    view,
    explanation,
    weather,
    routesError: asApiError(routesQuery.error),
    weatherError: asApiError(weatherQuery.error),
    routesAt: routesQuery.dataUpdatedAt,
    retryRoutes: () => void routesQuery.refetch(),
    retryWeather: () => void weatherQuery.refetch(),
  };
}
