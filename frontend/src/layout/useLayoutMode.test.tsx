import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetLayoutModeForTest, useLayoutMode } from './useLayoutMode';

// A viewport the test can resize: every media query reads the current width and height.
let width = 390;
let height = 664;
const listeners = new Set<() => void>();

function matches(text: string): boolean {
  if (text.includes('min-width: 1700px')) return width >= 1700;
  if (!text.includes('max-width: 599.95px')) return false;
  return width < 600 && (!text.includes('min-height: 500px') || height >= 500);
}

function resize(w: number, h: number) {
  width = w;
  height = h;
  act(() => listeners.forEach((listener) => listener()));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetLayoutModeForTest();
  width = 390;
  height = 664;
  listeners.clear();
  vi.stubGlobal('matchMedia', (text: string) => ({
    get matches() {
      return matches(text);
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const field = () => {
  const input = document.createElement('input');
  document.body.append(input);
  return input;
};

test('an upright phone gets the sheet, a short screen and a wide one the pane', () => {
  const { result } = renderHook(() => useLayoutMode());
  expect(result.current).toBe('sheet');
  resize(390, 400);
  expect(result.current).toBe('pane');
  resize(844, 390);
  expect(result.current).toBe('pane');
  resize(1800, 900);
  expect(result.current).toBe('wide');
});

test('the keyboard shrinking the page does not change the layout while a text field is focused', () => {
  const { result } = renderHook(() => useLayoutMode());
  const input = field();
  act(() => input.focus());

  resize(390, 340); // the keyboard rises

  expect(result.current).toBe('sheet');
  resize(390, 664); // and falls
  expect(result.current).toBe('sheet');
});

test('the layout follows the screen again once the field has lost focus', () => {
  const { result } = renderHook(() => useLayoutMode());
  const input = field();
  act(() => input.focus());
  resize(390, 340);
  expect(result.current).toBe('sheet');

  act(() => input.blur());
  act(() => void vi.advanceTimersByTime(400));

  expect(result.current).toBe('pane');
});

test('moving focus from one field to the next does not change the layout in between', () => {
  const { result } = renderHook(() => useLayoutMode());
  const first = field();
  const second = field();
  act(() => first.focus());
  resize(390, 340);

  act(() => first.blur()); // the blur comes before the next focus
  resize(390, 335); // the keyboard is still up and the screen changes again
  expect(result.current).toBe('sheet');
  act(() => second.focus());
  act(() => void vi.advanceTimersByTime(400));

  expect(result.current).toBe('sheet');
});

test('the focused form field is the same element after the keyboard opens', () => {
  function Form() {
    const mode = useLayoutMode();
    // The parent differs by mode, as AppShell's does: a changed mode would remount the input.
    return mode === 'sheet' ? (
      <section>
        <input aria-label="field" />
      </section>
    ) : (
      <div>
        <input aria-label="field" />
      </div>
    );
  }
  const { getByLabelText } = render(<Form />);
  const input = getByLabelText('field') as HTMLInputElement;
  act(() => input.focus());

  resize(390, 340);

  expect(input.isConnected).toBe(true);
  expect(document.activeElement).toBe(input);
});

test('a phone on its side with a short screen and no focused field gets the pane', () => {
  width = 568;
  height = 320;
  const { result } = renderHook(() => useLayoutMode());
  expect(result.current).toBe('pane');
});
