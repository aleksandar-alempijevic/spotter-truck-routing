import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './App';
import { createQueryClient } from './plan/queryClient';
import { createStandIn } from './test/standIn';
import { buildRoutes, buildWeather } from './test/fixtures';
import type { MapViewProps } from './map/MapView';

// The fake map: jsdom has no WebGL, so the real map is covered by the built-app browser run.
let mapProps: MapViewProps | null = null;
let mapThrows = false;
vi.mock('./map/MapView', () => ({
  default: function FakeMap(props: MapViewProps) {
    mapProps = props;
    if (mapThrows) throw new Error('the map broke while rendering');
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
  mapThrows = false;
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
  // Spies from a test (the console, for a caught render error) never outlive it.
  vi.restoreAllMocks();
});

// The trip bar is a button named by its own words: the places, the details, then "Edit".
const TRIP_BAR = /^Dallas → Denver .* Edit$/;

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

  fireEvent.click(screen.getByRole('button', { name: TRIP_BAR }));
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
  // Nothing will ask for a forecast, so the slider does not say it is waiting for one.
  expect(screen.queryByText('Waiting for the forecast')).not.toBeInTheDocument();
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
  expect(screen.getByRole('button', { name: TRIP_BAR })).toBeInTheDocument();
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

test('a map that throws while rendering leaves the panels up and says so in the map corner', async () => {
  mapThrows = true;
  // React reports a caught render error to the console; that is the boundary working.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useViewport('pane');
  renderApp();
  await planTrip();
  expect(await screen.findByText('Route 2 is recommended')).toBeInTheDocument();
  expect(await screen.findByText(/map is not available on this device/)).toBeInTheDocument();
  expect(screen.getAllByText(/Arrives /)).toHaveLength(3);
  expect(screen.queryByRole('button', { name: /key/ })).not.toBeInTheDocument();
});

test('phone: while the form covers the map the map is inert, and it is reachable again after', async () => {
  useViewport('sheet');
  renderApp();
  await screen.findByRole('button', { name: 'Plan routes' });
  const map = () => screen.getByTestId('map');
  await waitFor(() => expect(map()).toBeInTheDocument());
  expect(map().closest('[inert]')).not.toBeNull();

  await planTrip();
  await screen.findByText('Route 2 is recommended');
  expect(map().closest('[inert]')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: TRIP_BAR }));
  expect(map().closest('[inert]')).not.toBeNull();
});

test('focus follows the screen: results after a submit, the first field when the form opens, Edit trip when it closes', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  expect(document.activeElement).toBe(
    screen.getByRole('heading', { name: 'Routes from Dallas to Denver' }),
  );

  fireEvent.click(screen.getByRole('button', { name: TRIP_BAR }));
  expect(document.activeElement).toBe(screen.getByLabelText('Starting place'));

  fireEvent.click(screen.getByRole('button', { name: 'Back to results' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: TRIP_BAR }));
});

test('the answer is announced once it lands, in a live region of its own', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  const announced = screen
    .getAllByRole('status')
    .map((el) => el.textContent)
    .filter((text) => text?.startsWith('Results ready'));
  expect(announced).toEqual(['Results ready. 3 routes found.']);
});

test('a failed submit puts focus on the first field that is wrong', async () => {
  useViewport('sheet');
  renderApp();
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Starting place')));
  expect(screen.getByLabelText('Starting place')).toHaveAttribute('aria-invalid', 'true');
  expect(calls('/api/routes')).toBe(0);

  // With both places chosen, the cargo weight is the first thing wrong.
  await pick('Starting place', 'Dallas', 'Dallas, TX, United States');
  await pick('Destination', 'Denver', 'Denver, CO, United States');
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByLabelText('Cargo weight (lb)')),
  );
  const described = screen.getByLabelText('Cargo weight (lb)').getAttribute('aria-describedby');
  expect(document.getElementById(described!)).toHaveTextContent(
    'Enter the cargo weight in pounds.',
  );
});

test('the routes handed to the map keep their identity across form keystrokes, before and after a plan', async () => {
  useViewport('sheet');
  renderApp();
  await waitFor(() => expect(mapProps).not.toBeNull());
  const empty = mapProps!.routes;
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '12' } });
  // A new empty list each time would make the map redo its routes on every keystroke.
  expect(mapProps!.routes).toBe(empty);

  await planTrip();
  await screen.findByText('Route 2 is recommended');
  const planned = mapProps!.routes;
  expect(planned).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: TRIP_BAR }));
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '30,000' } });
  expect(mapProps!.routes).toBe(planned);
});

const LOST = /map is not available on this device/;
const NO_BASEMAP = /map background could not be loaded/;

test('a restored context clears the failed notice and brings the key back', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');

  act(() => mapProps!.onContextLost());
  expect(screen.getByText(LOST)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /key/ })).not.toBeInTheDocument();

  act(() => mapProps!.onRecovered());
  expect(screen.queryByText(LOST)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Hide key' })).toBeInTheDocument();
});

test('a restore leaves a "no basemap" notice in place, however the two arrived', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');

  // The basemap failed first, then the context was lost and came back.
  act(() => mapProps!.onBasemapUnavailable());
  act(() => mapProps!.onContextLost());
  expect(screen.getByText(LOST)).toBeInTheDocument();
  act(() => mapProps!.onRecovered());
  expect(screen.getByText(NO_BASEMAP)).toBeInTheDocument();
  expect(screen.queryByText(LOST)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Hide key' })).toBeInTheDocument();
});

test('a basemap error that arrives while the context is lost is kept for after the restore', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');

  act(() => mapProps!.onContextLost());
  act(() => mapProps!.onBasemapUnavailable());
  expect(screen.getByText(LOST)).toBeInTheDocument(); // failed outranks no-basemap
  act(() => mapProps!.onRecovered());
  expect(screen.getByText(NO_BASEMAP)).toBeInTheDocument();
});

test('a context lost before the first load stays lost through the style install, and a restore lifts it', async () => {
  useViewport('pane');
  renderApp();
  await waitFor(() => expect(mapProps).not.toBeNull());

  act(() => mapProps!.onContextLost());
  expect(screen.getByText(LOST)).toBeInTheDocument();
  // A style can install while the canvas is dead: that does not make the map healthy.
  act(() => mapProps!.onReady());
  expect(screen.getByText(LOST)).toBeInTheDocument();
  act(() => mapProps!.onRecovered());
  expect(screen.queryByText(LOST)).not.toBeInTheDocument();
});

test('a map that failed for good is not lifted by a ready or a restore', async () => {
  useViewport('pane');
  renderApp();
  await waitFor(() => expect(mapProps).not.toBeNull());

  act(() => mapProps!.onFailed());
  act(() => mapProps!.onReady());
  act(() => mapProps!.onRecovered());
  expect(screen.getByText(LOST)).toBeInTheDocument();
});

const spotHeading = () => screen.queryByRole('region', { name: 'Weather at the tapped spot' });

test('phone: a tap on the map is read in the sheet, with both readings, and no popup is asked for', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  expect(mapProps?.readoutOnMap).toBe(false);
  expect(spotHeading()).not.toBeInTheDocument();
  expect(screen.queryByText(/Arrives /)).not.toBeInTheDocument(); // the sheet is at its smallest

  act(() => mapProps!.onSpot({ cell: 0, checkpoint: { routeId: 'route-3', index: 2 } }));

  const reading = within(spotHeading()!);
  expect(reading.getByText(/^Checkpoint at arrival: /)).toBeInTheDocument();
  expect(reading.getByText(/^Heatmap at slider hour: /)).toBeInTheDocument();
  expect(mapProps?.spotOpen).toBe(true);
  // The sheet has opened to show it.
  expect(screen.getAllByText(/Arrives /)).toHaveLength(3);
});

test('phone: a tap on a cell alone reads the heatmap, and a tap elsewhere or the close button ends it', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');

  act(() => mapProps!.onSpot({ cell: 0, checkpoint: null }));
  expect(within(spotHeading()!).queryByText(/Checkpoint at arrival/)).not.toBeInTheDocument();
  expect(within(spotHeading()!).getByText(/Forecast for|No forecast for/)).toBeInTheDocument();

  act(() => mapProps!.onSpot(null));
  expect(spotHeading()).not.toBeInTheDocument();
  expect(mapProps?.spotOpen).toBe(false);

  act(() => mapProps!.onSpot({ cell: 0, checkpoint: null }));
  fireEvent.click(screen.getByRole('button', { name: 'Close the weather reading' }));
  expect(spotHeading()).not.toBeInTheDocument();
});

test('phone: the heatmap line of the reading follows the slider hour, and nothing else on the page re-renders for it', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  act(() => mapProps!.onSpot({ cell: 0, checkpoint: { routeId: 'route-3', index: 2 } }));
  const heatLine = () =>
    within(spotHeading()!).getByText(/^Forecast for |^No forecast for /).textContent;
  const checkpointLine = () =>
    within(spotHeading()!).getByText(/^Checkpoint at arrival: /).textContent;
  const before = heatLine();
  const checkpointBefore = checkpointLine();

  act(() => mapProps!.hour.set(mapProps!.hour.get() + 5));

  expect(heatLine()).not.toBe(before);
  expect(checkpointLine()).toBe(checkpointBefore);
});

test('phone: the reading belongs to its plan, and planning again leaves it behind', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  act(() => mapProps!.onSpot({ cell: 0, checkpoint: null }));
  expect(spotHeading()).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: TRIP_BAR }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));
  await screen.findByText('Route 2 is recommended');
  expect(spotHeading()).not.toBeInTheDocument();
});

test('pane: the map keeps its popup, and the pane shows no reading of its own', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  expect(mapProps?.readoutOnMap).toBe(true);

  act(() => mapProps!.onSpot({ cell: 0, checkpoint: { routeId: 'route-3', index: 2 } }));

  expect(spotHeading()).not.toBeInTheDocument();
  expect(mapProps?.spotOpen).toBe(false);
});

test('phone: closing the reading also drops the selected checkpoint, ring and list row', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  const ref = { routeId: 'route-3', index: 2 };
  act(() => {
    mapProps!.onSelectCheckpoint(ref);
    mapProps!.onSpot({ cell: 0, checkpoint: ref });
  });
  expect(mapProps?.selectedCheckpoint).toEqual(ref);

  fireEvent.click(screen.getByRole('button', { name: 'Close the weather reading' }));

  expect(spotHeading()).not.toBeInTheDocument();
  expect(mapProps?.selectedCheckpoint).toBeNull();
  expect(mapProps?.selectedRouteId).toBe('route-3'); // the route stays chosen
  expect(screen.queryByText('Selected checkpoint on Route 3')).not.toBeInTheDocument();
});

test('phone: a checkpoint chosen from the list since the tap keeps its selection when the reading closes', async () => {
  useViewport('sheet');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  act(() => {
    mapProps!.onSelectCheckpoint({ routeId: 'route-3', index: 2 });
    mapProps!.onSpot({ cell: 0, checkpoint: { routeId: 'route-3', index: 2 } });
  });
  act(() => mapProps!.onSelectCheckpoint({ routeId: 'route-3', index: 4 }));

  fireEvent.click(screen.getByRole('button', { name: 'Close the weather reading' }));

  expect(mapProps?.selectedCheckpoint).toEqual({ routeId: 'route-3', index: 4 });
});

const routesBodies = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === '/api/routes')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { rest_breaks: boolean });

const BREAKS_NOTE = /Times include the federal rest breaks/;
const STOP_KEY_ROW = /Required stop; the corner badge/;

test('the rest-break switch is on the form, off at the start, and says what it adds and assumes', () => {
  useViewport('sheet');
  renderApp();

  const toggle = screen.getByRole('switch', { name: 'Include required rest breaks' });

  expect(toggle).not.toBeChecked();
  expect(toggle).toHaveAccessibleDescription(/30-minute break after 8 hours.*rested start/);
});

test('the request carries the switch: false by default, true when it is on', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  expect(routesBodies()).toEqual([expect.objectContaining({ rest_breaks: false })]);

  fireEvent.click(screen.getByRole('button', { name: TRIP_BAR }));
  fireEvent.click(screen.getByRole('switch', { name: 'Include required rest breaks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));
  await screen.findByText(BREAKS_NOTE);

  expect(routesBodies().map((b) => b.rest_breaks)).toEqual([false, true]);
});

test('changing the switch makes a new submission: routes are requested again and nothing carries over', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');
  const offRoutes = mapProps!.routes;
  act(() => mapProps!.onSelectStop({ routeId: 'route-3', index: 0 }));

  fireEvent.click(screen.getByRole('button', { name: TRIP_BAR }));
  fireEvent.click(screen.getByRole('switch', { name: 'Include required rest breaks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));
  await screen.findByText(BREAKS_NOTE);
  await screen.findByText('Route 2 is recommended');

  expect(calls('/api/routes')).toBe(2);
  expect(calls('/api/weather')).toBe(2);
  expect(mapProps!.routes).not.toBe(offRoutes);
  expect(mapProps!.selectedRouteId).toBe('route-2'); // the recommended route again, not route-3
});

test('with the switch off there is no stop UI: no note, no stop rows, no stop on the trip bar', async () => {
  useViewport('pane');
  renderApp();
  await planTrip();
  await screen.findByText('Route 2 is recommended');

  expect(screen.queryByText(BREAKS_NOTE)).toBeNull();
  expect(screen.queryByText(/Break · mile|Rest · mile/)).toBeNull();
  expect(screen.queryByText(/driving \+/)).toBeNull();
  expect(screen.getByRole('button', { name: TRIP_BAR })).not.toHaveTextContent('rest breaks');
  expect(mapProps!.routes.every((r) => r.stops.length === 0)).toBe(true);
  await screen.findByRole('button', { name: 'Hide key' });
  expect(screen.queryByText(STOP_KEY_ROW)).toBeNull();
});

test('with the switch on the pane shows the note, the split, the stop rows and the trip bar says so', async () => {
  useViewport('pane');
  renderApp();
  await pick('Starting place', 'Dallas', 'Dallas, TX, United States');
  await pick('Destination', 'Denver', 'Denver, CO, United States');
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '36,000' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Include required rest breaks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));

  expect(await screen.findByText(BREAKS_NOTE)).toBeInTheDocument();
  expect(await screen.findByText('Route 2 is recommended')).toBeInTheDocument();
  await screen.findByRole('button', { name: 'Hide key' });
  expect(screen.getByText(STOP_KEY_ROW)).toBeInTheDocument();
  expect(
    screen.getAllByText(
      (_, el) =>
        el?.tagName === 'SPAN' &&
        /driving \+ 10 h 30 min breaks/.test(el.textContent ?? '') &&
        el.querySelector('span') !== null,
    ),
  ).toHaveLength(3);
  expect(screen.getAllByText(/^Break · mile \d+$/)).toHaveLength(1);
  expect(screen.getAllByText(/^Rest · mile \d+$/)).toHaveLength(1);
  expect(screen.getByRole('button', { name: TRIP_BAR })).toHaveTextContent('with rest breaks');
  // The trip bar's details wrap, so no separator can start a line.
  expect(screen.getByRole('button', { name: TRIP_BAR })).not.toHaveTextContent('·');
  // The note is one line; the rule and its assumptions sit behind a disclosure that holds them.
  expect(screen.getByText('The rule and its assumptions')).toBeInTheDocument();
  expect(
    screen.getByText(/34 hours off after 60 hours of driving.*rested start/),
  ).toBeInTheDocument();
});

test('on a phone the break note is left out at peek and shown at half and full', async () => {
  useViewport('sheet');
  renderApp();
  await pick('Starting place', 'Dallas', 'Dallas, TX, United States');
  await pick('Destination', 'Denver', 'Denver, CO, United States');
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '36,000' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Include required rest breaks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));
  await screen.findByText('Route 2 is recommended');

  expect(screen.queryByText(BREAKS_NOTE)).toBeNull(); // peek: the route chips need the room

  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByText(BREAKS_NOTE)).toBeInTheDocument(); // half

  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByText(BREAKS_NOTE)).toBeInTheDocument(); // full
});

test('the caption follows the answer, not the form: breaks asked for but not applied show none', async () => {
  useViewport('pane');
  const standIn = answer;
  let departure = '';
  answer = (method, url, body) => {
    const reply = standIn(method, url, body);
    if (url === '/api/routes') {
      const asked = JSON.parse(body) as { rest_breaks: boolean; departure: string };
      expect(asked.rest_breaks).toBe(true);
      departure = asked.departure;
      return { ...reply, body: buildRoutes('mixed', { departure, breaks: false }) };
    }
    if (url === '/api/weather') return { ...reply, body: buildWeather('mixed', { departure }) };
    return reply;
  };
  renderApp();
  await pick('Starting place', 'Dallas', 'Dallas, TX, United States');
  await pick('Destination', 'Denver', 'Denver, CO, United States');
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '36,000' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Include required rest breaks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));

  await screen.findByText('Route 2 is recommended');

  expect(screen.queryByText(BREAKS_NOTE)).toBeNull();
  expect(screen.queryByText(/Break · mile/)).toBeNull();
  expect(screen.getByRole('button', { name: TRIP_BAR })).not.toHaveTextContent('rest breaks');
});

test('a trip with breaks on and no stop says so on its card and still carries the note', async () => {
  useViewport('pane');
  renderApp();
  await pick('Starting place', 'Dallas', 'Dallas, TX, United States');
  await pick('Destination', 'Fort Worth', 'Fort Worth, TX, United States');
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '36,000' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Include required rest breaks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));

  expect(await screen.findByText(BREAKS_NOTE)).toBeInTheDocument();
  expect(await screen.findByText(/no breaks needed/)).toBeInTheDocument();
  expect(screen.queryByText(/Break · mile|Rest · mile/)).toBeNull();
});

test('phone: a stop tapped on the map opens the sheet to it and is marked in the list', async () => {
  useViewport('sheet');
  renderApp();
  await pick('Starting place', 'Dallas', 'Dallas, TX, United States');
  await pick('Destination', 'Denver', 'Denver, CO, United States');
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '36,000' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Include required rest breaks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));
  await screen.findByText('Route 2 is recommended');

  act(() => mapProps!.onSelectStop({ routeId: 'route-3', index: 1 }));

  expect(await screen.findByText('Selected stop on Route 3')).toBeInTheDocument();
  expect(mapProps?.selectedRouteId).toBe('route-3');
  expect(mapProps?.selectedCheckpoint).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(document.querySelector('[aria-current="true"]')).toHaveTextContent(/^Rest · mile/);
});

test('with breaks on a stop row reads "checking weather" until the weather lands, then its weather', async () => {
  useViewport('pane');
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const standIn = fetchMock.getMockImplementation() as (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/weather') await held;
    return standIn(url, init);
  });
  renderApp();
  await pick('Starting place', 'Dallas', 'Dallas, TX, United States');
  await pick('Destination', 'Denver', 'Denver, CO, United States');
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '36,000' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Include required rest breaks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));

  await screen.findByText(BREAKS_NOTE);
  const rest = () => screen.getByText(/^Rest · mile/).closest('li')!;
  expect(within(rest()).getByText('Checking weather')).toBeInTheDocument();

  release();
  await screen.findByText('Route 2 is recommended');
  expect(within(rest()).queryByText('Checking weather')).toBeNull();
  expect(within(rest()).getByText(/Wind \d+ mph/)).toBeInTheDocument();
  expect(screen.getAllByText(/Worst during the stop, at /).length).toBeGreaterThan(0);
});

test('the weather request carries the stops the routes answer listed', async () => {
  useViewport('pane');
  renderApp();
  await pick('Starting place', 'Dallas', 'Dallas, TX, United States');
  await pick('Destination', 'Denver', 'Denver, CO, United States');
  fireEvent.change(screen.getByLabelText('Cargo weight (lb)'), { target: { value: '36,000' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Include required rest breaks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Plan routes' }));
  await screen.findByText('Route 2 is recommended');

  const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/weather')!;
  const sent = JSON.parse(String((init as RequestInit).body)) as {
    routes: { id: string; stops: { kind: string }[] }[];
  };

  expect(sent.routes.map((r) => r.stops.map((s) => s.kind))).toEqual([
    ['break', 'rest'],
    ['break', 'rest'],
    ['break', 'rest'],
  ]);
});
