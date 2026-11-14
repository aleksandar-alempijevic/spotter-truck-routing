import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AddressField } from './form/AddressField';
import { WaitStatus } from './panel/WaitStatus';

// The hook's own rules are tested in hosting.test.tsx; here it is replaced, so these tests cover
// only where each wait shows the notice and when it asks for one.
const NOTICE = 'the wake notice';
const asked = vi.hoisted(() => ({ value: true, calls: [] as Array<[boolean, number]> }));
vi.mock('./hosting', () => ({
  useWakeNotice: (waiting: boolean, afterMs: number) => {
    asked.calls.push([waiting, afterMs]);
    return waiting && asked.value ? NOTICE : null;
  },
}));
vi.mock('./api/endpoints', () => ({ fetchAddresses: () => new Promise(() => {}) }));

beforeEach(() => {
  asked.value = true;
  asked.calls.length = 0;
});
afterEach(cleanup);

test('the routes wait shows the notice after 20 s of waiting', () => {
  render(<WaitStatus stage="routes" sinceMs={Date.now()} />);
  expect(screen.getByText(NOTICE)).toBeInTheDocument();
  expect(asked.calls.at(-1)).toEqual([true, 20_000]);
});

test('the weather wait never asks for it', () => {
  render(<WaitStatus stage="weather" sinceMs={Date.now()} />);
  expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  expect(asked.calls.at(-1)?.[0]).toBe(false);
});

function AddressWithText() {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <AddressField
        label="Start"
        text="Salt Lake"
        choice={null}
        onChange={() => {}}
        onCredit={() => {}}
      />
    </QueryClientProvider>
  );
}

test.each([
  [true, true],
  [false, false],
])('an address search that asks for the notice (%s) shows it: %s', async (given, shown) => {
  vi.useFakeTimers();
  asked.value = given;
  render(<AddressWithText />);
  fireEvent.mouseDown(screen.getByRole('combobox')); // opens the list
  await act(async () => void vi.advanceTimersByTime(500)); // past the debounce: the search starts
  expect(screen.queryByText(`Still searching. ${NOTICE}`) !== null).toBe(shown);
  expect(asked.calls.at(-1)).toEqual([true, 10_000]);
  vi.useRealTimers();
});
