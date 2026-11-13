// The API's answers as a function of the request, shared by the component tests and by the
// stand-in server the browser proof runs against. Types only, so Node can run it directly.
import type { RoutesIn, WeatherIn } from '../api/types';
import {
  ADDRESS_ATTRIBUTION,
  buildRoutes,
  buildWeather,
  SCENARIO_KEYS,
  scenarioDestination,
  suggestionsFor,
  type ScenarioKey,
} from './fixtures.ts';

interface StandInReply {
  status: number;
  body: unknown;
}

/** Which scenario a trip gets: by its destination, so the form needs no special input. */
function scenarioFor(destination: { lat: number; lon: number }): ScenarioKey {
  return (
    SCENARIO_KEYS.find((key) => {
      const d = scenarioDestination(key);
      return d.lat === destination.lat && d.lon === destination.lon;
    }) ?? 'mixed'
  );
}

/**
 * A stand-in for the three endpoints. The weather request does not repeat the destination or the
 * departure, so the stand-in remembers the routes request the weather answer belongs to.
 */
export function createStandIn(options: { cellDegrees?: number } = {}) {
  let last: { scenario: ScenarioKey; departure: string } | null = null;

  return function answer(method: string, url: string, bodyText: string): StandInReply {
    const { pathname, searchParams } = new URL(url, 'http://stand-in.invalid');
    if (pathname === '/api/address-search') {
      return {
        status: 200,
        body: {
          suggestions: suggestionsFor(searchParams.get('q') ?? ''),
          attribution: ADDRESS_ATTRIBUTION,
        },
      };
    }
    if (method === 'POST' && pathname === '/api/routes') {
      const body = JSON.parse(bodyText) as RoutesIn;
      last = { scenario: scenarioFor(body.destination), departure: body.departure };
      return {
        status: 200,
        body: buildRoutes(last.scenario, {
          departure: body.departure,
          spacing: body.checkpoint_interval_miles,
          loadLb: body.load_lb,
        }),
      };
    }
    if (method === 'POST' && pathname === '/api/weather' && last) {
      const body = JSON.parse(bodyText) as WeatherIn;
      return {
        status: 200,
        body: buildWeather(last.scenario, {
          departure: last.departure,
          spacing: body.checkpoint_interval_miles,
          loadLb: body.load_lb,
          cellDegrees: options.cellDegrees,
        }),
      };
    }
    return { status: 404, body: { code: 'not_found', message: 'No such endpoint.' } };
  };
}
