import { afterEach, expect, test, vi } from 'vitest';
import { fetchHealth } from './health';

afterEach(() => vi.unstubAllGlobals());

test('returns the parsed body on success', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: 'ok' })));

  await expect(fetchHealth()).resolves.toEqual({ status: 'ok' });
});

test('throws with the HTTP status when the response is not ok', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 })));

  await expect(fetchHealth()).rejects.toThrow('Health check failed with HTTP 502');
});
