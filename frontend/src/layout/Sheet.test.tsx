import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Sheet, type SheetState } from './Sheet';

// jsdom lays nothing out: an element is 200 px tall unless a height was written to its style, as
// the sheet does while dragged, and the screen is 800 px, so the stops are half 400 and full 800
// with the peek stop at the 200 px the sheet measures.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return parseFloat(this.style.height) || 200;
  });
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

// The drags above are instant, which reads as a flick; these move over two seconds, so only where
// the finger stops counts. The events' clock is the page's, so a fake one sets how long a drag
// takes. A sheet at full height is 800 px tall.
function slowDragFromFull(distance: number) {
  const { onState, handle } = setup('full');
  screen.getByRole('region', { name: 'Routes and weather' }).style.height = '800px';
  vi.useFakeTimers({ toFake: ['Date'] });
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100, button: 0 });
  vi.advanceTimersByTime(1000);
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 + distance });
  vi.advanceTimersByTime(1000);
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 + distance });
  vi.useRealTimers();
  return onState.mock.calls;
}

test('a slow drag down from full that stops near half ends at half', () => {
  expect(slowDragFromFull(400)).toEqual([['half']]);
});

test('a slow drag down from full that goes nearly to the bottom ends at peek', () => {
  expect(slowDragFromFull(600)).toEqual([['peek']]);
});

test('a slow drag down from full that stops short of the middle stays full', () => {
  expect(slowDragFromFull(100)).toEqual([]);
});

test('a quick flick down from full moves one step, to half, wherever it stops', () => {
  const { onState, handle } = setup('full');
  screen.getByRole('region', { name: 'Routes and weather' }).style.height = '800px';
  vi.useFakeTimers({ toFake: ['Date'] });
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100, button: 0 });
  vi.advanceTimersByTime(20);
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 650 });
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: 650 });
  vi.useRealTimers();
  expect(onState.mock.calls).toEqual([['half']]);
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
