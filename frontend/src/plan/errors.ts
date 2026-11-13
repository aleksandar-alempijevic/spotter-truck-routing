import type { ApiError, ApiErrorCode } from '../api/client';

/** Which request failed; the same code can need different advice per request. */
export type ErrorContext = 'routes' | 'weather' | 'address';

export type ErrorAction = 'retry' | 'edit' | 'none';

export interface ErrorMessage {
  title: string;
  body: string;
  action: ErrorAction;
}

const TRY_LATER = 'Please try again in a moment.';

// A Record over the full code union: a code added on the backend fails `tsc` until it has a row.
const BASE: Record<ApiErrorCode, ErrorMessage> = {
  validation_error: {
    title: 'Something in the request was refused',
    body: 'Check the trip details and plan again.',
    action: 'edit',
  },
  not_found: { title: 'The service did not answer here', body: TRY_LATER, action: 'retry' },
  method_not_allowed: {
    title: 'The service did not accept the request',
    body: TRY_LATER,
    action: 'retry',
  },
  internal_error: { title: 'Something went wrong on our side', body: TRY_LATER, action: 'retry' },
  no_route: {
    title: 'No truck route found',
    body: 'There is no truck route between these two places. Choose different places.',
    action: 'edit',
  },
  provider_timeout: {
    title: 'The data provider took too long',
    body: 'It did not answer in time. Try again, or plan a shorter trip.',
    action: 'retry',
  },
  provider_unavailable: {
    title: 'A data provider is down',
    body: 'The service we ask for routes or weather is not answering. Try again in a few minutes.',
    action: 'retry',
  },
  provider_limited: {
    title: 'The data provider is busy',
    body: 'We hit its request limit. Try again in a minute; what was already fetched is reused.',
    action: 'retry',
  },
  provider_not_configured: {
    title: 'This service is not set up yet',
    body: 'The server has no key for this data provider, so nothing can be done from here.',
    action: 'none',
  },
  provider_malformed_response: {
    title: 'The data provider sent something unreadable',
    body: TRY_LATER,
    action: 'retry',
  },
  provider_error: { title: 'The data provider failed', body: TRY_LATER, action: 'retry' },
  unknown: {
    title: 'Something unexpected happened',
    body: 'The request failed in a way we do not recognise. Try again.',
    action: 'retry',
  },
};

const OVERRIDES: Record<ErrorContext, Partial<Record<ApiErrorCode, ErrorMessage>>> = {
  routes: {
    validation_error: {
      title: 'The trip was refused',
      body: 'Check the places, the departure time (from now to 48 hours ahead) and the cargo weight, then plan again.',
      action: 'edit',
    },
  },
  weather: {
    // One code covers two causes, and the code is all the client may branch on: say both.
    validation_error: {
      title: 'Weather could not be checked for this trip',
      body: 'Either part of the trip is outside the area we cover (latitude 15 to 72, longitude -170 to -50), or the trip needs too many forecast points. Try a wider checkpoint spacing, or a trip inside the area.',
      action: 'edit',
    },
    provider_limited: {
      title: 'The weather service is busy',
      body: 'We hit its request limit. Your routes are still shown. Try again in a minute; forecasts already fetched are reused.',
      action: 'retry',
    },
    provider_timeout: {
      title: 'The weather service took too long',
      body: 'Your routes are still shown. Try again, or plan with a wider checkpoint spacing.',
      action: 'retry',
    },
  },
  address: {
    provider_limited: {
      title: 'Address search is busy',
      body: 'Wait a moment and keep typing.',
      action: 'none',
    },
    provider_not_configured: {
      title: 'Address search is not set up',
      body: 'The server has no key for address search.',
      action: 'none',
    },
    validation_error: {
      title: 'Address search refused that text',
      body: 'Type between 3 and 100 characters.',
      action: 'none',
    },
    no_route: {
      title: 'Address search failed',
      body: 'Keep typing, or try again.',
      action: 'none',
    },
  },
};

export function describeError(context: ErrorContext, error: ApiError): ErrorMessage {
  return OVERRIDES[context][error.code] ?? BASE[error.code];
}
