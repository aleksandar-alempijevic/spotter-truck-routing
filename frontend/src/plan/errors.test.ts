import { expect, test } from 'vitest';
import { ApiError, type ApiErrorCode } from '../api/client';
import type { ErrorOut } from '../api/types';
import { describeError, type ErrorContext } from './errors';

// Every code of the generated union, plus the client-only one. A code added on the backend
// fails `tsc` here, in the Record, until it is listed.
const CODES: Record<ErrorOut['code'], true> = {
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
};
const ALL: ApiErrorCode[] = [...(Object.keys(CODES) as ErrorOut['code'][]), 'unknown'];
const CONTEXTS: ErrorContext[] = ['routes', 'weather', 'address'];

test.each(CONTEXTS.flatMap((c) => ALL.map((code) => [c, code] as const)))(
  '%s / %s has a title, a body and an action',
  (context, code) => {
    const row = describeError(context, new ApiError(code, 'server text that must not show', 500));
    expect(row.title.length).toBeGreaterThan(3);
    expect(row.body.length).toBeGreaterThan(10);
    expect(['retry', 'edit', 'none']).toContain(row.action);
    expect(row.title + row.body).not.toContain('server text');
  },
);

test('the same code reads differently per request', () => {
  const err = new ApiError('validation_error', 'x', 422);
  expect(describeError('weather', err).body).toMatch(/outside the area/);
  expect(describeError('routes', err).body).not.toMatch(/outside the area/);
});

test('branching is on the code, never on the message', () => {
  const a = describeError('weather', new ApiError('provider_limited', 'routes: Value error', 503));
  const b = describeError('weather', new ApiError('provider_limited', 'anything else', 503));
  expect(a).toEqual(b);
});

test('weather provider_limited offers the manual retry that reuses the cache', () => {
  const row = describeError('weather', new ApiError('provider_limited', 'x', 503));
  expect(row.action).toBe('retry');
  expect(row.body).toMatch(/reused/);
});

test('no route sends the driver back to edit the trip', () => {
  expect(describeError('routes', new ApiError('no_route', 'x', 422)).action).toBe('edit');
});
