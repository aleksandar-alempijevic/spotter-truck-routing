import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Legend } from './Legend';

// jsdom lays nothing out, so the list's scroll geometry is set by hand: 300 px of rows in 100.
let scrollTop = 0;
beforeEach(() => {
  scrollTop = 0;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => scrollTop);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const list = () => document.getElementById('map-legend')!;
const cue = () =>
  [...document.querySelectorAll('[aria-hidden="true"]')].find((e) => e.textContent === 'More ▾');

test('a key whose rows do not all fit shows a cue at its foot, and is a tab stop', () => {
  render(<Legend open onToggle={() => {}} />);
  expect(cue()).toBeTruthy();
  expect(list()).toHaveAttribute('tabindex', '0');
  expect(list()).toHaveAccessibleName('Map key, scrolls');
});

test('scrolled to the end the cue goes, and the list stays a tab stop', () => {
  render(<Legend open onToggle={() => {}} />);
  scrollTop = 200;
  act(() => void fireEvent.scroll(list()));
  expect(cue()).toBeFalsy();
  expect(list()).toHaveAttribute('tabindex', '0');
});

test('a key that fits has no cue and is not a tab stop', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100);
  render(<Legend open onToggle={() => {}} />);
  expect(cue()).toBeFalsy();
  expect(list()).not.toHaveAttribute('tabindex');
});

test('a closed key has no list and no cue', () => {
  render(<Legend open={false} onToggle={() => {}} />);
  expect(document.getElementById('map-legend')).toBeNull();
  expect(cue()).toBeFalsy();
});

test('the key explains the stop mark only when the plan has stops', () => {
  const { rerender } = render(<Legend open onToggle={() => {}} />);
  expect(document.body.textContent).not.toContain('Required stop');

  rerender(<Legend open hasStops onToggle={() => {}} />);
  expect(document.body.textContent).toContain('Required stop; the corner badge');
});
