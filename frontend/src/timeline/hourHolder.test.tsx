import { act, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { buildWeather } from '../test/fixtures';
import { buildGridModel } from './grid';
import { createHourHolder } from './hourHolder';
import { HourSlider } from './HourSlider';

test('subscribers hear a change once, and not a repeat of the same hour', () => {
  const holder = createHourHolder();
  const listener = vi.fn();
  const off = holder.subscribe(listener);
  holder.set(5);
  holder.set(5);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(5);
  off();
  holder.set(6);
  expect(listener).toHaveBeenCalledTimes(1);
});

const weather = buildWeather('mixed', { departure: '2026-11-20T14:00:00Z' });
const model = buildGridModel(weather.grid, weather.departure);

test('the slider reads and writes the holder and labels the hour in clock time', () => {
  const holder = createHourHolder();
  render(<HourSlider holder={holder} model={model} zone="America/Chicago" />);
  const slider = screen.getByRole('slider', { name: 'Forecast hour' });
  expect(slider).toHaveAttribute('aria-valuemax', String(model.hourCount - 1));
  expect(screen.getByText(/\+0 h/)).toBeInTheDocument();

  act(() => holder.set(6));
  expect(screen.getByText(/\+6 h/)).toBeInTheDocument();
  expect(slider).toHaveAttribute('aria-valuenow', '6');
  expect(slider.getAttribute('aria-valuetext')).toMatch(/\d\d:\d\d C[SD]T, 6 hours/);
});

test('without a grid the slider is disabled and says what it waits for', () => {
  render(<HourSlider holder={createHourHolder()} model={null} zone="America/Chicago" />);
  expect(screen.getByRole('slider')).toBeDisabled();
  expect(screen.getByText('Waiting for the forecast')).toBeInTheDocument();
});

test('a slider change goes to the holder and nowhere else', () => {
  const holder = createHourHolder();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  render(<HourSlider holder={holder} model={model} zone="America/Chicago" />);
  const slider = screen.getByRole('slider');
  slider.focus();
  act(() => {
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  expect(holder.get()).toBe(1);
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
