import type { CheckpointView, RouteView, StopView } from '../plan/view';
import { formatDuration } from '../time/zone';

export type ListItem =
  { kind: 'checkpoint'; cp: CheckpointView } | { kind: 'stop'; stop: StopView };

/**
 * A route's checkpoints and stops in time order, for the list. A checkpoint reached exactly where
 * a stop begins comes before it. Nothing here changes a checkpoint's index.
 */
export function interleave(route: RouteView): ListItem[] {
  const items: ListItem[] = [];
  let next = 0;
  for (const cp of route.checkpoints) {
    while (next < route.stops.length && route.stops[next].startMs < cp.etaMs) {
      items.push({ kind: 'stop', stop: route.stops[next++] });
    }
    items.push({ kind: 'checkpoint', cp });
  }
  return items;
}

const KIND_WORDS = {
  break: { name: 'Break', what: '30-minute break' },
  rest: { name: 'Rest', what: '10-hour rest' },
  restart: { name: 'Restart', what: '34-hour restart' },
} as const;

export const stopName = (stop: StopView): string => KIND_WORDS[stop.kind].name;

/** "Break", "10-hour rest": what the stop is, in the driver's words. */
export const stopWhat = (stop: StopView): string => KIND_WORDS[stop.kind].what;

/** Total time stopped on a route. */
export const stoppedSeconds = (route: RouteView): number =>
  route.stops.reduce((sum, stop) => sum + stop.durationSeconds, 0);

/**
 * How a route's door-to-door time splits, when the plan has breaks: "15 h 10 min driving + 10 h
 * 30 min breaks". Null when no stop was needed.
 */
export function splitText(route: RouteView): string | null {
  if (route.stops.length === 0) return null;
  return `${formatDuration(route.drivingSeconds)} driving + ${formatDuration(stoppedSeconds(route))} breaks`;
}

/** Said beside every time that includes a stop. */
export const BREAKS_ASSUMPTION =
  'Times include the federal rest breaks: 30 minutes after 8 hours of driving and 10 hours off after 11. They assume a rested start and no time except driving, and a stop is placed where its limit is reached, which may not be a truck stop.';

/** Said beside the stop rows. */
export const STOPS_ASSUMPTION =
  'Stops assume a rested start and no time except driving; each is placed where its limit is reached.';
