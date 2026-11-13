import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './App';
import { createQueryClient } from './plan/queryClient';
import { createStandIn } from './test/standIn';
import { buildRoutes } from './test/fixtures';
import type { MapViewProps } from './map/MapView';

// The fake map: jsdom has no WebGL, so the real map is covered by the built-app browser run.
let mapProps: MapViewProps | null = null;
vi.mock('./map/MapView', () => ({
  default: function FakeMap(props: MapViewProps) {
    mapProps = props;
    return <div data-testid="map" />;
  },
}));

function useViewport(mode: 'sheet' | 'pane' | 'wide') {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: mode === 'sheet' || (mode === 'wide' && query.includes('min-width: 1700px')),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

let fetchMock: ReturnType<typeof vi.fn>;
let answer: ReturnType<typeof createStandIn>;
let weatherFails: boolean;
let weatherFailure: Response | null;
let addressTimeouts: number;

beforeEach(() => {
  mapProps = null;
  weatherFails = false;
  weatherFailure = null;
  addressTimeouts = 0;
  answer = createStandIn();
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (weatherFailure && url === '/api/weather') return Promise.resolve(weatherFailure.clone());
    if (addressTimeouts > 0 && url.startsWith('/api/address-search')) {
      addressTimeouts -= 1;
      return Promise.resolve(
        Response.json({ code: 'provider_timeout', message: 'slow' }, { status: 504 }),
      );
    }
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

test('a search that starts with a number hints at adding the city', async () => {
  useViewport('sheet');
  renderApp();
  fireEvent.change(screen.getByLabelText('Starting place'), { target: { value: '1600 Penn' } });
  expect(await screen.findByText('Add the city for faster results')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Starting place'), { target: { value: 'Dallas' } });
  await waitFor(() =>
    expect(screen.queryByText('Add the city for faster results')).not.toBeInTheDocument(),
  );
});

test('a timed-out address search is shown inline and retried only on request', async () => {
  useViewport('sheet');
  addressTimeouts = 1;
  renderApp();
  fireEvent.change(screen.getByLabelText('Starting place'), { target: { value: 'Dallas' } });

  expect(await screen.findByText(/Address search took too long/)).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 400));
  expect(calls('/api/address-search')).toBe(1);

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  fireEvent.keyDown(screen.getByLabelText('Starting place'), { key: 'ArrowDown' });
  expect(
    await screen.findByRole('option', { name: 'Dallas, TX, United States' }),
  ).toBeInTheDocument();
  expect(calls('/api/address-search')).toBe(2);
});

test('the long-trip notice shows for 10-mile spacing and not otherwise', () => {
  useViewport('sheet');
  renderApp();
  const notice = /on a long trip the weather can take about a minute/;
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '10 mi' }));
  expect(screen.getByText(notice)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '50 mi' }));
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
});

test.each([
  ['outside_service_area', /outside the area we cover/, 'Edit trip'],
  ['too_many_locations', /too many forecast points/, 'Edit trip'],
] as const)(
  'a weather %s refusal keeps the routes and sends the driver to edit',
  async (code, title, action) => {
    useViewport('pane');
    weatherFailure = Response.json({ code, message: 'Value error, routes: x' }, { status: 422 });
    renderApp();
    await planTrip();

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(mapProps?.routes).toHaveLength(3);
    expect(screen.getAllByText(/Arrives /)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: action }));
    expect(screen.getByRole('button', { name: 'Plan routes' })).toBeInTheDocument();
    expect(calls('/api/weather')).toBe(1);
  },
);

test('a gateway page instead of an API body is an unknown failure with one retry', async () => {
  useViewport('pane');
  weatherFailure = new Response('<html>Bad gateway</html>', { status: 502 });
  renderApp();
  await planTrip();

  expect(await screen.findByText('Something unexpected happened')).toBeInTheDocument();
  expect(mapProps?.routes).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.queryByText(/Bad gateway/)).not.toBeInTheDocument();
});

test('a routes failure shows the message in the panel and plans again only when asked', async () => {
  useViewport('pane');
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      url.startsWith('/api/address-search')
        ? Response.json(answer('GET', url, '').body)
        : Response.json({ code: 'no_route', message: 'x' }, { status: 422 }),
    ),
  );
  renderApp();
  await planTrip();

  expect(await screen.findByText('No truck route found')).toBeInTheDocument();
  expect(calls('/api/routes')).toBe(1);
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Edit trip' }));
  expect(screen.getByRole('button', { name: 'Plan routes' })).toBeInTheDocument();
  expect(calls('/api/routes')).toBe(1);
});

test('phone: Back collapses an expanded sheet and leaves the page alone', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  expect(await screen.findByText('Route 2 is recommended')).toBeInTheDocument();
  const before = window.history.length;

  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getAllByText(/Arrives /)).toHaveLength(3);
  expect(window.history.length).toBe(before + 1);

  window.history.back();
  await waitFor(() => expect(screen.queryByText(/Arrives /)).not.toBeInTheDocument());
  expect(screen.getByText('Route 2 is recommended')).toBeInTheDocument();
});

test('phone: collapsing by a button gives the history entry back', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  expect(await screen.findByText('Route 2 is recommended')).toBeInTheDocument();

  const prior = window.history.state;
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(window.history.state?.sheet).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Less' }));
  await waitFor(() => expect(window.history.state).toEqual(prior));
  // The sheet is at peek, and the entry it pushed is gone.
  expect(screen.queryByText(/Arrives /)).not.toBeInTheDocument();
});

test('widest screens: the cards and the checkpoints are both there, side by side in the pane', async () => {
  useViewport('wide');
  renderApp();
  await planTrip();
  expect(await screen.findByText('Route 2 is recommended')).toBeInTheDocument();
  expect(screen.getAllByText(/Arrives /)).toHaveLength(3);
  expect(screen.getByText('Route 2 checkpoints')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit trip' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
});

test('phone: the shortfall note and the credits are on the smallest sheet, no tap needed', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip(['Amarillo', 'Amarillo, TX, United States']);
  const note = buildRoutes('shortfall', { departure: '2026-11-20T14:00:00Z' }).shortfall!.message;
  expect(await screen.findByText(note)).toBeInTheDocument();
  expect(screen.queryByText(/Arrives /)).not.toBeInTheDocument();
  expect(await screen.findByRole('link', { name: /Open-Meteo/ })).toBeInTheDocument();
});

test('the map key lists every level and the hatch, open on a roomy screen and a toggle on a phone', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  const key = screen.getByRole('button', { name: 'Hide key' });
  expect(key).toHaveAttribute('aria-expanded', 'true');
  const list = within(document.getElementById('map-legend')!);
  for (const label of ['Low', 'Moderate', 'High', 'Severe', 'No Travel', 'No forecast']) {
    expect(list.getByText(label)).toBeInTheDocument();
  }
  fireEvent.click(key);
  expect(document.getElementById('map-legend')).toBeNull();
  cleanup();

  useViewport('sheet');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  const phoneKey = screen.getByRole('button', { name: 'Map key' });
  expect(phoneKey).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(phoneKey);
  expect(document.getElementById('map-legend')).not.toBeNull();
});

test('the map notice and the key share the map corner: a failed map hides the key, a missing basemap keeps it', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  expect(screen.getByRole('button', { name: 'Hide key' })).toBeInTheDocument();

  act(() => mapProps!.onBasemapUnavailable());
  expect(screen.getByText(/map background could not be loaded/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Hide key' })).toBeInTheDocument();

  act(() => mapProps!.onFailed());
  expect(screen.getByText(/map is not available on this device/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /key/ })).not.toBeInTheDocument();
});
