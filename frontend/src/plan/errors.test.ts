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
  outside_service_area: true,
  too_many_locations: true,
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
  const err = new ApiError('provider_limited', 'x', 503);
  expect(describeError('weather', err).title).toMatch(/weather/i);
  expect(describeError('address', err).title).toMatch(/address/i);
  expect(describeError('routes', err).title).not.toMatch(/weather|address/i);
});

test('the two weather refusals each say their own way forward', () => {
  const area = describeError('weather', new ApiError('outside_service_area', 'x', 422));
  const many = describeError('weather', new ApiError('too_many_locations', 'x', 422));
  expect(area.body).toMatch(/latitude 15 and 72/);
  expect(area.body).not.toMatch(/spacing/);
  expect(many.body).toMatch(/wider checkpoint spacing/);
  expect(many.body).not.toMatch(/latitude/);
  expect([area.action, many.action]).toEqual(['edit', 'edit']);
});

test('a plain validation error on the weather request no longer claims either cause', () => {
  const row = describeError('weather', new ApiError('validation_error', 'x', 422));
  expect(row.body).not.toMatch(/spacing|latitude/);
});

test('a timed-out address search is retryable and says why numbers are slow', () => {
  const row = describeError('address', new ApiError('provider_timeout', 'x', 504));
  expect(row.action).toBe('retry');
  expect(row.body).toMatch(/city/);
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

test('no route explains that routes through Canada are not shown', () => {
  const message = describeError('routes', new ApiError('no_route', 'x', 422));
  expect(message.body).toContain('Canada');
  expect(message.body).toContain('Alaska');
});

test('no route sends the driver back to edit the trip', () => {
  expect(describeError('routes', new ApiError('no_route', 'x', 422)).action).toBe('edit');
});
