import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HOST_SLEEPS, WAKE_NOTICE, hostSleeps, useWaitedLong } from './hosting';
import { AddressField } from './form/AddressField';
import { WaitStatus, WAKE_NOTICE_AFTER_S } from './panel/WaitStatus';

vi.mock('./api/endpoints', () => ({ fetchAddresses: () => new Promise(() => {}) }));

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

test('a build with no value set has the wake copy off', () => {
  expect(HOST_SLEEPS).toBe(false);
});

test('a build with the value set to 1 turns it on, and an empty value leaves it off', async () => {
  vi.stubEnv('VITE_HOST_SLEEPS', '1');
  vi.resetModules();
  expect((await import('./hosting')).HOST_SLEEPS).toBe(true);

  vi.stubEnv('VITE_HOST_SLEEPS', '');
  vi.resetModules();
  expect((await import('./hosting')).HOST_SLEEPS).toBe(false);
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

test('useWaitedLong turns true only after the wait has run that long, and resets', () => {
  const { result, rerender } = renderHook(({ waiting }) => useWaitedLong(waiting, 1000), {
    initialProps: { waiting: true },
  });
  expect(result.current).toBe(false);
  act(() => void vi.advanceTimersByTime(1000));
  expect(result.current).toBe(true);
  rerender({ waiting: false });
  expect(result.current).toBe(false);
});

function routesWait(hostSleepsValue: boolean) {
  render(<WaitStatus stage="routes" sinceMs={Date.now()} hostSleeps={hostSleepsValue} />);
}

test('the routes wait says the server may be waking up, only on a sleeping host, only when long', () => {
  routesWait(true);
  expect(screen.queryByText(WAKE_NOTICE)).not.toBeInTheDocument();
  act(() => void vi.advanceTimersByTime((WAKE_NOTICE_AFTER_S + 1) * 1000));
  expect(screen.getByText(WAKE_NOTICE)).toBeInTheDocument();
});

test('the routes wait never says it when the host does not sleep', () => {
  routesWait(false);
  act(() => void vi.advanceTimersByTime((WAKE_NOTICE_AFTER_S + 5) * 1000));
  expect(screen.queryByText(WAKE_NOTICE)).not.toBeInTheDocument();
});

test('the weather wait never carries it', () => {
  render(<WaitStatus stage="weather" sinceMs={Date.now()} hostSleeps />);
  act(() => void vi.advanceTimersByTime(60_000));
  expect(screen.queryByText(WAKE_NOTICE)).not.toBeInTheDocument();
});

function AddressWithText({ hostSleepsValue }: { hostSleepsValue: boolean }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <AddressField
        label="Start"
        text="Salt Lake"
        choice={null}
        onChange={() => {}}
        onCredit={() => {}}
        hostSleeps={hostSleepsValue}
      />
    </QueryClientProvider>
  );
}

test.each([
  [true, true],
  [false, false],
])('a long address search with hostSleeps=%s shows the wake copy: %s', async (sleeps, shown) => {
  render(<AddressWithText hostSleepsValue={sleeps} />);
  fireEvent.mouseDown(screen.getByRole('combobox')); // opens the list
  await act(async () => void vi.advanceTimersByTime(500)); // past the debounce: the search starts
  expect(screen.queryByText(`Still searching. ${WAKE_NOTICE}`)).not.toBeInTheDocument();
  await act(async () => void vi.advanceTimersByTime(5000));
  expect(screen.queryByText(`Still searching. ${WAKE_NOTICE}`) !== null).toBe(shown);
});
