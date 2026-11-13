import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useBackCollapse } from './useBackCollapse';

// jsdom's history traverses on a timer; here the browser's popstate is sent by hand, so a test can
// put things in between a `back()` and the pop it causes.
let pushState: ReturnType<typeof vi.spyOn>;
let back: ReturnType<typeof vi.spyOn>;
const pop = () => act(() => void window.dispatchEvent(new PopStateEvent('popstate')));

beforeEach(() => {
  pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
  back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function setup(initial: boolean) {
  const collapse = vi.fn();
  const view = renderHook(({ open }) => useBackCollapse(open, collapse), {
    initialProps: { open: initial },
  });
  return { collapse, set: (open: boolean) => view.rerender({ open }) };
}

test('opening takes one entry; Back consumes it and collapses', () => {
  const { collapse } = setup(true);
  expect(pushState).toHaveBeenCalledTimes(1);
  pop();
  expect(collapse).toHaveBeenCalledTimes(1);
  expect(back).not.toHaveBeenCalled();
});

test('closing by another route gives the entry back, and that pop collapses nothing', () => {
  const { collapse, set } = setup(true);
  set(false);
  expect(back).toHaveBeenCalledTimes(1);
  pop();
  expect(collapse).not.toHaveBeenCalled();
});

test('reopening before the pop of the close arrives pushes only after that pop', () => {
  const { collapse, set } = setup(true);
  set(false);
  set(true);
  // The pending pop would take an entry pushed now away, so none is pushed yet.
  expect(pushState).toHaveBeenCalledTimes(1);
  pop();
  expect(pushState).toHaveBeenCalledTimes(2);
  expect(collapse).not.toHaveBeenCalled();
  // The reopened sheet owns its entry: Back collapses it.
  pop();
  expect(collapse).toHaveBeenCalledTimes(1);
});

test('closing again before the pop arrives leaves the history as it was', () => {
  const { collapse, set } = setup(true);
  set(false);
  set(true);
  set(false);
  pop();
  expect(pushState).toHaveBeenCalledTimes(1);
  expect(back).toHaveBeenCalledTimes(1);
  expect(collapse).not.toHaveBeenCalled();
});
