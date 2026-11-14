import type { AttributionOut, Spacing, SuggestionOut } from '../api/types';
import {
  DEFAULT_SPACING,
  GRACE_MS,
  HORIZON_HOURS,
  MAX_LOAD_LB,
  SEARCH_MAX_CHARS,
  SEARCH_MIN_CHARS,
  type Trip,
} from '../plan/trip';
import { HOUR_MS, wallClockToInstant } from '../time/zone';

// Keep one minute clear of the backend's horizon.
const HORIZON_MS = HORIZON_HOURS * HOUR_MS - 60_000;

export type DepartureValue = { mode: 'now' } | { mode: 'at'; local: string };

export interface FormValues {
  origin: SuggestionOut | null;
  originText: string;
  destination: SuggestionOut | null;
  destinationText: string;
  departure: DepartureValue;
  loadText: string;
  spacing: Spacing;
  restBreaks: boolean;
  addressCredit: AttributionOut | null;
}

/** The cargo weight starts empty; spacing starts at 25; rest breaks start off. */
export const INITIAL_VALUES: FormValues = {
  origin: null,
  originText: '',
  destination: null,
  destinationText: '',
  departure: { mode: 'now' },
  loadText: '',
  spacing: DEFAULT_SPACING,
  restBreaks: false,
  addressCredit: null,
};

interface FormErrors {
  origin?: string;
  destination?: string;
  departure?: string;
  load?: string;
}

/** Whether the driver has typed something, but not yet enough to search. */
export function tooShortToSearch(text: string): boolean {
  const length = text.trim().length;
  return length > 0 && length < SEARCH_MIN_CHARS;
}

/** Whether the text is long enough, and not too long, to send to address search. */
export function canSearch(text: string): boolean {
  const length = text.trim().length;
  return length >= SEARCH_MIN_CHARS && length <= SEARCH_MAX_CHARS;
}

export function parseLoad(text: string): { value: number } | { error: string } {
  const cleaned = text.replace(/[,\s]/g, '');
  if (cleaned === '') return { error: 'Enter the cargo weight in pounds.' };
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { error: 'Use numbers only.' };
  const value = Number(cleaned);
  if (!(value > 0)) return { error: 'The weight must be more than 0 lb.' };
  if (value > MAX_LOAD_LB)
    return { error: `The weight can be at most ${MAX_LOAD_LB.toLocaleString('en-US')} lb.` };
  return { value };
}

const sameSpot = (a: SuggestionOut, b: SuggestionOut) =>
  a.label === b.label || (a.lat === b.lat && a.lon === b.lon);

/** The trip, or the reasons there is none. "Leave now" is resolved against `nowMs` here. */
export function validateTrip(
  values: FormValues,
  nowMs: number,
): { trip: Trip; errors: null } | { trip: null; errors: FormErrors } {
  const errors: FormErrors = {};

  if (!values.origin) {
    errors.origin = values.originText.trim()
      ? 'Choose a starting place from the suggestions.'
      : 'Choose a starting place.';
  }
  if (!values.destination) {
    errors.destination = values.destinationText.trim()
      ? 'Choose a destination from the suggestions.'
      : 'Choose a destination.';
  } else if (values.origin && sameSpot(values.origin, values.destination)) {
    errors.destination = 'The destination must differ from the starting place.';
  }

  const load = parseLoad(values.loadText);
  if ('error' in load) errors.load = load.error;

  let departureMs: number | null = null;
  if (values.departure.mode === 'now') {
    departureMs = nowMs;
  } else if (!values.origin) {
    errors.departure = 'Choose the starting place first: the time is read in its time zone.';
  } else {
    departureMs = wallClockToInstant(values.departure.local, values.origin.timezone);
    if (departureMs === null) errors.departure = 'Enter a departure date and time.';
    else if (departureMs < nowMs - GRACE_MS) errors.departure = 'That time has already passed.';
    else if (departureMs > nowMs + HORIZON_MS)
      errors.departure = `Departure can be at most ${HORIZON_HOURS} hours ahead.`;
  }

  if (
    Object.keys(errors).length > 0 ||
    !values.origin ||
    !values.destination ||
    departureMs === null ||
    'error' in load
  ) {
    return { trip: null, errors };
  }
  return {
    trip: {
      origin: values.origin,
      destination: values.destination,
      departureMs,
      loadLb: load.value,
      spacing: values.spacing,
      restBreaks: values.restBreaks,
      addressCredit: values.addressCredit,
    },
    errors: null,
  };
}
