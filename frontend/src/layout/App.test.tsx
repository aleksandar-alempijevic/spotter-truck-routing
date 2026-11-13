import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { createQueryClient } from '../plan/queryClient';
import { createStandIn } from '../test/standIn';
import type { MapViewProps } from '../map/MapView';

// The fake map: jsdom has no WebGL, so the real map is covered by the built-app browser run.
let mapProps: MapViewProps | null = null;
vi.mock('../map/MapView', () => ({
  default: function FakeMap(props: MapViewProps) {
    mapProps = props;
    return <div data-testid="map" />;
  },
}));

function useViewport(mode: 'sheet' | 'pane') {
  vi.stubGlobal('matchMedia', () => ({
    matches: mode === 'sheet',
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

let fetchMock: ReturnType<typeof vi.fn>;
let answer: ReturnType<typeof createStandIn>;
let weatherFails: boolean;

beforeEach(() => {
  mapProps = null;
  weatherFails = false;
  answer = createStandIn();
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (weatherFails && url === '/api/weather') {
      return Promise.resolve(
        Response.json({ code: 'provider_limited', message: 'busy' }, { status: 503 }),
      );
    }
    const reply = answer(init?.method ?? 'GET', url, String(init?.body ?? ''));
    return Promise.resolve(Response.json(reply.body, { status: reply.status }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const calls = (path: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith(path)).length;

function renderApp() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <App />
    </QueryClientProvider>,
  );
}

async function pick(label: string, text: string, option: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

async function planTrip(
  destination: readonly [string, string] = ['Denver', 'Denver, CO, United States'],
) {
  await pick('Starting place', 'Dallas', 'Dallas, TX, United States');
  await pick('Destination', destination[0], destination[1]);
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '36,000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));
}

test('the cargo weight starts empty and is required: nothing is requested without it', async () => {
  useViewport('sheet');
  renderApp();
  expect(screen.getByLabelText('Cargo weight (lb)')).toHaveValue('');
  expect(screen.getByRole('button', { name: '25 mi' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));
  expect(await screen.findByText('Enter the cargo weight in pounds.')).toBeInTheDocument();
  expect(calls('/api/routes')).toBe(0);
});

test('address search waits for three characters', async () => {
  useViewport('sheet');
  renderApp();
  fireEvent.change(screen.getByLabelText('Starting place'), { target: { value: 'Da' } });
  await new Promise((r) => setTimeout(r, 500));
  expect(calls('/api/address-search')).toBe(0);
});

test('phone: routes appear first, then the weather; the sheet opens by buttons, and each request is made once', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();

  // The routes answer is in and the weather is pending: the map has routes with no risk yet.
  await waitFor(() => expect(mapProps?.routes).toHaveLength(3));
  expect(mapProps?.grid ?? null).toBeNull();

  expect(await screen.findByText('Route 2 is recommended')).toBeInTheDocument();
  expect(mapProps?.grid).not.toBeNull();
  const group = screen.getByRole('group', { name: 'Routes' });
  expect(within(group).getAllByRole('button')).toHaveLength(3);

  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getAllByText(/Arrives /)).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByText('Route 2 checkpoints')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'More' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Less' }));
  fireEvent.click(screen.getByRole('button', { name: 'Less' }));
  expect(screen.queryByText(/Arrives /)).not.toBeInTheDocument();

  act(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
  });
  expect(calls('/api/routes')).toBe(1);
  expect(calls('/api/weather')).toBe(1);
});

test('wide: the pane shows the headline, every card and the checkpoints at once', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  expect(await screen.findByText('Route 2 is recommended')).toBeInTheDocument();
  expect(screen.getAllByText(/Arrives /)).toHaveLength(3);
  expect(screen.getByText('Route 2 checkpoints')).toBeInTheDocument();
  expect(screen.getByRole('slider', { name: 'Forecast hour' })).toBeEnabled();
  expect(screen.getByText(/Open-Meteo/)).toBeInTheDocument();
});

test('a checkpoint chosen on the map is shown in the sheet', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  act(() => mapProps!.onSelectCheckpoint({ routeId: 'route-3', index: 2 }));
  expect(await screen.findByText('Selected checkpoint on Route 3')).toBeInTheDocument();
  expect(mapProps?.selectedRouteId).toBe('route-3');
});

test('planning again drops the selection and the plan, and requests once more', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  act(() => mapProps!.onSelectRoute('route-3'));
  expect(mapProps?.selectedRouteId).toBe('route-3');

  fireEvent.click(screen.getByRole('button', { name: 'Edit trip' }));
  fireEvent.click(screen.getByRole('button', { name: '50 mi' }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));

  await waitFor(() => expect(calls('/api/routes')).toBe(2));
  await waitFor(() => expect(mapProps?.selectedRouteId).toBe('route-2'));
  expect(calls('/api/weather')).toBe(2);
});

test('a weather failure keeps the routes and offers one manual retry', async () => {
  useViewport('pane');
  weatherFails = true;
  renderApp();
  await planTrip();

  expect(await screen.findByText('The weather service is busy')).toBeInTheDocument();
  expect(mapProps?.routes).toHaveLength(3);
  expect(screen.getAllByText(/Arrives /)).toHaveLength(3);
  expect(calls('/api/weather')).toBe(1);

  weatherFails = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Route 2 is recommended')).toBeInTheDocument();
  expect(calls('/api/weather')).toBe(2);
  expect(calls('/api/routes')).toBe(1);
});

test('a plan with no safe route says so instead of recommending one', async () => {
  useViewport('pane');
  renderApp();
  await planTrip(['Wichita', 'Wichita, KS, United States']);
  expect(await screen.findByText('No route is safe to recommend')).toBeInTheDocument();
});
