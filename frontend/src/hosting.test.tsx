import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WAKE_NOTICE, hostSleeps, useWakeNotice } from './hosting';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

test.each([
  ['1', true],
  ['true', true],
  ['', false],
  [undefined, false],
  ['0', false],
  ['false', false],
])('the build value %j means hosted=%s', (value, expected) => {
  expect(hostSleeps(value)).toBe(expected);
});

test('an empty basemap style value means the default style', async () => {
  vi.stubEnv('VITE_BASEMAP_STYLE', '');
  vi.resetModules();
  expect((await import('./map/basemap')).BASEMAP_STYLE_URL).toBe(
    'https://tiles.openfreemap.org/styles/positron',
  );

  vi.stubEnv('VITE_BASEMAP_STYLE', 'https://example.test/style.json');
  vi.resetModules();
  expect((await import('./map/basemap')).BASEMAP_STYLE_URL).toBe('https://example.test/style.json');
});

test('useWakeNotice says the notice only after the wait has run that long, and resets', () => {
  vi.stubEnv('VITE_HOST_SLEEPS', '1');
  const { result, rerender } = renderHook(({ waiting }) => useWakeNotice(waiting, 1000), {
    initialProps: { waiting: true },
  });
  expect(result.current).toBeNull();
  act(() => void vi.advanceTimersByTime(1000));
  expect(result.current).toBe(WAKE_NOTICE);
  rerender({ waiting: false });
  expect(result.current).toBeNull();
});

test.each([[''], ['0'], [undefined]])(
  'useWakeNotice never says it when the build value is %j',
  (value) => {
    vi.stubEnv('VITE_HOST_SLEEPS', value);
    const { result } = renderHook(() => useWakeNotice(true, 1000));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current).toBeNull();
  },
);
