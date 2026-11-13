import type { AttributionOut, RoutesIn, Spacing, SuggestionOut } from '../api/types';

export const SPACINGS: readonly Spacing[] = [10, 25, 50];
export const DEFAULT_SPACING: Spacing = 25;
/** The backend's bounds on the cargo weight; the form mirrors them. */
export const MAX_LOAD_LB = 80_000;
/** Address search is sent only between these lengths; the backend refuses anything outside. */
export const SEARCH_MIN_CHARS = 3;
export const SEARCH_MAX_CHARS = 100;
/** A departure may be up to this far ahead, and a few minutes in the past is forgiven. */
export const HORIZON_HOURS = 48;
export const GRACE_MS = 10 * 60_000; // the backend forgives 15 minutes; keep clear of the edge

/** A validated trip: the only thing the form hands to planning. */
export interface Trip {
  origin: SuggestionOut;
  destination: SuggestionOut;
  /** The instant the truck leaves. "Leave now" is resolved when the trip is submitted. */
  departureMs: number;
  loadLb: number;
  spacing: Spacing;
  /** Geoapify's credit as the address search last returned it. */
  addressCredit: AttributionOut | null;
}

/**
 * One press of "Plan routes". Everything that must not survive a re-plan (both query keys, the
 * selection, the slider hour) hangs off `id`, which is new for every submission.
 */
export interface Submission {
  id: number;
  trip: Trip;
  startedAt: number;
}

let lastId = 0;

export function newSubmission(trip: Trip, now = Date.now()): Submission {
  lastId += 1;
  return { id: lastId, trip, startedAt: now };
}

/** Every time on screen is read in the origin's zone. */
export const displayZone = (trip: Trip): string => trip.origin.timezone;

export function buildRoutesBody(trip: Trip): RoutesIn {
  return {
    load_lb: trip.loadLb,
    checkpoint_interval_miles: trip.spacing,
    origin: { lat: trip.origin.lat, lon: trip.origin.lon },
    destination: { lat: trip.destination.lat, lon: trip.destination.lon },
    departure: new Date(trip.departureMs).toISOString(),
  };
}
