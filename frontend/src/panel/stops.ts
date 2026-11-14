import { mergeByTime, type Timed } from '../plan/schedule';
import type { CheckpointView, RouteView, StopView } from '../plan/view';
import { formatDuration } from '../time/zone';

export type ListItem = Timed<CheckpointView, StopView>;

// The merge is worked out once per route, not once per render.
const merged = new WeakMap<RouteView, ListItem[]>();

/**
 * A route's checkpoints and stops in time order, for the list. Nothing here changes a
 * checkpoint's index.
 */
export function interleave(route: RouteView): ListItem[] {
  let found = merged.get(route);
  if (!found) {
    found = mergeByTime(route.checkpoints, route.stops);
    merged.set(route, found);
  }
  return found;
}

const KIND_WORDS = {
  break: { name: 'Break', noun: 'break' },
  rest: { name: 'Rest', noun: 'rest' },
  restart: { name: 'Restart', noun: 'restart' },
} as const;

export const stopName = (stop: StopView): string => KIND_WORDS[stop.kind].name;

/** "30 min break", "10 h rest": what the stop is, its length being the one the server planned. */
export const stopWhat = (stop: StopView): string =>
  `${formatDuration(stop.durationSeconds)} ${KIND_WORDS[stop.kind].noun}`;

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
