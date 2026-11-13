import type { ErrorOut } from './types';

/** The server's closed set of error codes, or `unknown` for anything that is not one of them. */
export type ApiErrorCode = ErrorOut['code'] | 'unknown';

// A Record over the generated union: a code added on the backend fails `tsc` here until listed.
const KNOWN_CODES: Record<ErrorOut['code'], true> = {
  validation_error: true,
  not_found: true,
  method_not_allowed: true,
  internal_error: true,
  no_route: true,
  provider_timeout: true,
  provider_unavailable: true,
  provider_limited: true,
  provider_not_configured: true,
  provider_malformed_response: true,
  provider_error: true,
  outside_service_area: true,
  too_many_locations: true,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Whatever a query failed with, as an `ApiError`; null when it did not fail. */
export function asApiError(error: unknown): ApiError | null {
  if (error === null || error === undefined) return null;
  return error instanceof ApiError ? error : new ApiError('unknown', 'The request failed.', 0);
}

function isKnownCode(value: unknown): value is ErrorOut['code'] {
  return typeof value === 'string' && Object.hasOwn(KNOWN_CODES, value);
}

/** The body is exactly `{code, message}` with a code from the closed set; anything else is unknown. */
function parseErrorBody(body: unknown): { code: ErrorOut['code']; message: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('code') || !keys.includes('message')) return null;
  const { code, message } = body as Record<string, unknown>;
  if (!isKnownCode(code) || typeof message !== 'string') return null;
  return { code, message };
}

/**
 * One fetch wrapper for every endpoint. It sets no client deadline: the server's own budgets
 * (120 s routes, 150 s weather) are the limit, and an abort comes only from the caller's signal.
 */
export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError('unknown', 'The request did not reach the server.', 0);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const parsed = parseErrorBody(body);
    if (parsed) throw new ApiError(parsed.code, parsed.message, response.status);
    throw new ApiError(
      'unknown',
      `The server answered with HTTP ${response.status}.`,
      response.status,
    );
  }
  if (body === undefined) {
    throw new ApiError(
      'unknown',
      'The server answered with something that is not JSON.',
      response.status,
    );
  }
  return body as T;
}
