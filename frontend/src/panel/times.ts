import { displayZone, type Trip } from '../plan/trip';
import type { RouteView } from '../plan/view';
import { formatClock, offsetAt, zoneAbbreviation } from '../time/zone';

/** "Tue 14:00 CST": a time in the origin's zone, the zone every time on screen is read in. */
export function originClock(trip: Trip, ms: number): string {
  const zone = displayZone(trip);
  return `${formatClock(ms, zone)} ${zoneAbbreviation(ms, zone)}`;
}

/** The instant a route arrives: its last checkpoint, which sits at the route's end. */
export function arrivalMs(route: RouteView): number {
  return route.checkpoints[route.checkpoints.length - 1].etaMs;
}

/**
 * The arrival in the origin's zone, and in the destination's zone too when the two clocks differ
 * at that instant. Null when the destination reads the same as the origin.
 */
export function arrivalInDestinationZone(trip: Trip, ms: number): string | null {
  const origin = displayZone(trip);
  const destination = trip.destination.timezone;
  if (offsetAt(ms, origin) === offsetAt(ms, destination)) return null;
  return `${formatClock(ms, destination)} ${zoneAbbreviation(ms, destination)}`;
}
