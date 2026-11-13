import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, request } from './client';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: Response | Error | DOMException) {
  const fn =
    response instanceof Response
      ? vi.fn().mockResolvedValue(response)
      : vi.fn().mockRejectedValue(response);
  vi.stubGlobal('fetch', fn);
}

async function failure(): Promise<ApiError> {
  const error = await request('/x').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

test('returns the parsed body on success', async () => {
  stubFetch(Response.json({ a: 1 }));
  await expect(request('/x')).resolves.toEqual({ a: 1 });
});

test('a coded error keeps its code, message and status', async () => {
  stubFetch(Response.json({ code: 'provider_limited', message: 'Slow down.' }, { status: 503 }));
  const error = await failure();
  expect([error.code, error.message, error.status]).toEqual([
    'provider_limited',
    'Slow down.',
    503,
  ]);
});

test.each([
  ['a gateway page', new Response('<html>bad gateway</html>', { status: 502 })],
  [
    'a body with extra keys',
    Response.json({ code: 'no_route', message: 'x', extra: 1 }, { status: 422 }),
  ],
  ['a body without a message', Response.json({ code: 'no_route' }, { status: 422 })],
  [
    'a code outside the closed set',
    Response.json({ code: 'teapot', message: 'x' }, { status: 418 }),
  ],
  ['an array', Response.json([{ code: 'no_route', message: 'x' }], { status: 422 })],
])('%s is an unknown failure', async (_name, response) => {
  stubFetch(response);
  expect((await failure()).code).toBe('unknown');
});

test('a network failure is an unknown failure', async () => {
  stubFetch(new TypeError('Failed to fetch'));
  expect((await failure()).code).toBe('unknown');
});

test('a successful answer that is not JSON is an unknown failure', async () => {
  stubFetch(new Response('ok', { status: 200 }));
  expect((await failure()).code).toBe('unknown');
});

test('an abort from the caller is not turned into an API error', async () => {
  const controller = new AbortController();
  controller.abort();
  stubFetch(new DOMException('Aborted', 'AbortError'));
  const error = await request('/x', { signal: controller.signal }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DOMException);
});
