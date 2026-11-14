import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { buildPlanView } from '../plan/view';
import { buildRoutes, buildWeather } from '../test/fixtures';
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

test('when the routes request has failed the slider says there is no forecast to wait for', () => {
  render(
    <HourSlider holder={createHourHolder()} model={null} zone="America/Chicago" routesFailed />,
  );
  expect(screen.getByText('No routes, so no forecast')).toBeInTheDocument();
  expect(screen.queryByText('Waiting for the forecast')).not.toBeInTheDocument();
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

test('the one-hour buttons step the holder and stop at the ends', () => {
  const holder = createHourHolder();
  render(<HourSlider holder={holder} model={model} zone="America/Chicago" />);
  const back = screen.getByRole('button', { name: /^−1 h/ });
  const forward = screen.getByRole('button', { name: /^\+1 h/ });
  expect(back).toBeDisabled();
  fireEvent.click(forward);
  fireEvent.click(forward);
  expect(holder.get()).toBe(2);
  fireEvent.click(back);
  expect(holder.get()).toBe(1);
  act(() => holder.set(model.hourCount - 1));
  expect(forward).toBeDisabled();
  expect(back).toBeEnabled();
});

test('the buttons are disabled with no forecast', () => {
  render(<HourSlider holder={createHourHolder()} model={null} zone="America/Chicago" />);
  expect(screen.getByRole('button', { name: /^\+1 h/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /^−1 h/ })).toBeDisabled();
});

test('the marks are labelled now, and the day boundaries', () => {
  render(
    <HourSlider
      holder={createHourHolder()}
      model={model}
      zone="America/Chicago"
      nowMs={model.startMs}
    />,
  );
  expect(screen.getByText('Now')).toBeInTheDocument();
  expect(screen.getByText('Sat')).toBeInTheDocument();
});

test('the truck readout follows the hour through the holder alone', () => {
  const departure = '2026-11-20T14:00:00Z';
  const view = buildPlanView(
    buildRoutes('mixed', { departure }),
    buildWeather('mixed', { departure }),
  );
  const holder = createHourHolder();
  render(
    <HourSlider
      holder={holder}
      model={model}
      zone="America/Chicago"
      routes={view.routes}
      nowMs={model.startMs}
    />,
  );
  expect(screen.getByText(/Trucks: Route 1 at mile 0/)).toBeInTheDocument();
  act(() => holder.set(3));
  expect(screen.getByText(/Route 1 at mile 1\d\d/)).toBeInTheDocument();
  act(() => holder.set(model.hourCount - 1));
  expect(
    screen.getByText(/Route 1 arrived · Route 2 arrived · Route 3 arrived/),
  ).toBeInTheDocument();
});
