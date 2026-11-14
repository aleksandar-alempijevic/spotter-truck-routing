/** How a route's required stops fall among its checkpoints, in time order. */

/** A stop's end: its start and its duration. */
export const stopEndMs = (stop: { startMs: number; durationSeconds: number }): number =>
  stop.startMs + stop.durationSeconds * 1000;

export type Timed<C, S> = { kind: 'checkpoint'; cp: C } | { kind: 'stop'; stop: S };

/**
 * The checkpoints and the stops merged by time. A checkpoint reached exactly where a stop begins
 * comes before it: the one place that tie is decided. Neither input's order or indexes change.
 */
export function mergeByTime<C extends { etaMs: number }, S extends { startMs: number }>(
  checkpoints: readonly C[],
  stops: readonly S[],
): Timed<C, S>[] {
  const items: Timed<C, S>[] = [];
  let next = 0;
  for (const cp of checkpoints) {
    while (next < stops.length && stops[next].startMs < cp.etaMs) {
      items.push({ kind: 'stop', stop: stops[next++] });
    }
    items.push({ kind: 'checkpoint', cp });
  }
  return items;
}
