import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Sheet, type SheetState } from './Sheet';

// jsdom lays nothing out: every element is 200 px tall and the screen 800 px, so the stops are
// peek 200, half 400 and full 800.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200);
  vi.stubGlobal('innerHeight', 800);
  HTMLElement.prototype.setPointerCapture = () => {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(state: SheetState) {
  const onState = vi.fn();
  const onDragging = vi.fn();
  const shown: SheetState[] = [];
  render(
    <Sheet state={state} onState={onState} onDragging={onDragging} topClearance={0}>
      {(tier) => {
        shown.push(tier);
        return <p>content at {tier}</p>;
      }}
    </Sheet>,
  );
  return {
    onState,
    onDragging,
    shown,
    handle: screen.getByRole('button', { name: /the results/ }),
  };
}

function drag(handle: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: from, button: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: to });
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: to });
}

test('a drag up from peek ends at the next state, and the release is not also a tap', () => {
  const { onState, onDragging, handle } = setup('peek');
  drag(handle, 700, 400);
  expect(onState).toHaveBeenCalledTimes(1);
  expect(onState).toHaveBeenCalledWith('half');
  expect(onDragging.mock.calls).toEqual([[true], [false]]);
  fireEvent.click(handle);
  expect(onState).toHaveBeenCalledTimes(1);
});

test('the content follows the height the finger has reached, and the height is released after', () => {
  const { handle, shown } = setup('peek');
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700, button: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 400 });
  expect(shown.at(-1)).toBe('half');
  const sheet = screen.getByRole('region', { name: 'Routes and weather' });
  expect(sheet.style.height).not.toBe('');
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: 400 });
  expect(sheet.style.height).toBe('');
});

test('a drag down from full ends below full', () => {
  const { onState, handle } = setup('full');
  drag(handle, 100, 500);
  expect(onState).toHaveBeenCalledTimes(1);
  expect(onState.mock.calls[0][0]).not.toBe('full');
});

test('a tap that barely moves is a tap: it cycles the state and starts no drag', () => {
  const { onState, onDragging, handle } = setup('peek');
  drag(handle, 700, 698);
  fireEvent.click(handle);
  expect(onDragging).not.toHaveBeenCalled();
  expect(onState).toHaveBeenCalledWith('half');
});

test('a cancelled drag leaves the state alone', () => {
  const { onState, handle } = setup('peek');
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700, button: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 400 });
  fireEvent.pointerCancel(handle, { pointerId: 1 });
  expect(onState).not.toHaveBeenCalled();
});
