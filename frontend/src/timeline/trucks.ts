// Where a truck is on a route at a given instant, from the checkpoint ETAs the wire carries.
// Pure: nothing here knows about React or the map.

/** What a route must offer; the plan's route view has all of it. */
export interface TruckRoute {
  id: string;
  name: string;
  miles: number;
  /** The route's polyline as [lon, lat]. */
  line: readonly (readonly [number, number])[];
  /** In order, by mile, each with the instant the truck is expected there. */
  checkpoints: readonly { mile: number; etaMs: number }[];
}

export type TruckStatus = 'before' | 'driving' | 'arrived';

export interface Truck {
  routeId: string;
  name: string;
  status: TruckStatus;
  /** Miles from the start; 0 before departure and the route's length once arrived. */
  mile: number;
  /** [lon, lat], where the truck is on the road. */
  position: [number, number];
}

/**
 * The mile a truck has reached at an instant. Between two checkpoints it is interpolated in
 * time, which assumes nothing about speed beyond the two ETAs: a stretch the ETAs make slow,
 * such as one with a break in it, comes out slow.
 */
export function mileAt(
  checkpoints: TruckRoute['checkpoints'],
  miles: number,
  ms: number,
): { status: TruckStatus; mile: number } {
  const first = checkpoints[0];
  const last = checkpoints[checkpoints.length - 1];
  if (!first || ms < first.etaMs) return { status: 'before', mile: 0 };
  if (ms >= last.etaMs) return { status: 'arrived', mile: miles };
  let i = 1;
  while (i < checkpoints.length - 1 && checkpoints[i].etaMs <= ms) i++;
  const a = checkpoints[i - 1];
  const b = checkpoints[i];
  const span = b.etaMs - a.etaMs;
  const fraction = span > 0 ? (ms - a.etaMs) / span : 1;
  return { status: 'driving', mile: a.mile + (b.mile - a.mile) * fraction };
}

const EARTH_MILES = 3958.8;

function haversineMiles(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return EARTH_MILES * 2 * Math.asin(Math.sqrt(h));
}

// The line's running length is worked out once per route, not once per slider step.
const lengths = new WeakMap<object, Float64Array>();

function runningLength(line: TruckRoute['line']): Float64Array {
  let found = lengths.get(line);
  if (!found) {
    found = new Float64Array(line.length);
    for (let i = 1; i < line.length; i++)
      found[i] = found[i - 1] + haversineMiles(line[i - 1], line[i]);
    lengths.set(line, found);
  }
  return found;
}

/**
 * The point on the polyline at a mile. The line is reduced and its own length need not equal the
 * route's, so distance along it is scaled to the route's miles.
 */
export function pointAtMile(
  line: TruckRoute['line'],
  miles: number,
  mile: number,
): [number, number] {
  if (line.length === 0) return [0, 0];
  const along = runningLength(line);
  const total = along[along.length - 1];
  if (line.length === 1 || total === 0 || miles <= 0) return [line[0][0], line[0][1]];
  const target = Math.min(Math.max(mile / miles, 0), 1) * total;
  let lo = 1;
  let hi = line.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (along[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const span = along[lo] - along[lo - 1];
  const f = span > 0 ? (target - along[lo - 1]) / span : 0;
  return [
    line[lo - 1][0] + (line[lo][0] - line[lo - 1][0]) * f,
    line[lo - 1][1] + (line[lo][1] - line[lo - 1][1]) * f,
  ];
}

export function trucksAt(routes: readonly TruckRoute[], ms: number): Truck[] {
  return routes.map((route) => {
    const { status, mile } = mileAt(route.checkpoints, route.miles, ms);
    return {
      routeId: route.id,
      name: route.name,
      status,
      mile,
      position: pointAtMile(route.line, route.miles, mile),
    };
  });
}

/** "Route 1 at mile 240", "Route 2 not left yet", "Route 3 arrived". */
export function describeTruck(truck: Truck): string {
  if (truck.status === 'before') return `${truck.name} not left yet`;
  if (truck.status === 'arrived') return `${truck.name} arrived`;
  return `${truck.name} at mile ${Math.round(truck.mile)}`;
}
