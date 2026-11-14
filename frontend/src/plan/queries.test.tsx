import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildRoutes, buildWeather, DALLAS, scenarioDestination } from '../test/fixtures';
import { createQueryClient } from './queryClient';
import { usePlan, type PlanState } from './queries';
import { newSubmission, type Submission } from './trip';

const departureMs = Date.now() + 3_600_000;
const trip = () => ({
  origin: DALLAS,
  destination: scenarioDestination('mixed'),
  departureMs,
  loadLb: 36_000,
  spacing: 25 as const,
  restBreaks: false,
  addressCredit: null,
});
const departure = new Date(departureMs).toISOString();

let latest: PlanState;
function Probe({ submission }: { submission: Submission | null }) {
  const state = usePlan(submission);
  useEffect(() => {
    latest = state;
  });
  return <span>{state.phase}</span>;
}

function setup(submission: Submission | null) {
  const client = createQueryClient();
  const ui = (s: Submission | null, key?: string) => (
    <QueryClientProvider client={client}>
      <Probe key={key} submission={s} />
    </QueryClientProvider>
  );
  return { ui, ...render(ui(submission)) };
}

const calls = (fetchMock: ReturnType<typeof vi.fn>, path: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith(path)).length;

const json = (body: unknown, status = 200) => Response.json(body, { status });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function disturb() {
  act(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
}

test('a failed routes request is made once: no retry, no refetch on focus, online or remount', async () => {
  fetchMock.mockResolvedValue(json({ code: 'provider_timeout', message: 'x' }, 504));
  const submission = newSubmission(trip());
  const { ui, rerender } = setup(submission);

  await waitFor(() => expect(latest.phase).toBe('routes_error'));
  disturb();
  rerender(ui(submission, 'remounted'));
  await waitFor(() => expect(latest.phase).toBe('routes_error'));
  disturb();
  await new Promise((r) => setTimeout(r, 50));

  expect(calls(fetchMock, '/api/routes')).toBe(1);
  expect(latest.routesError?.code).toBe('provider_timeout');
});

test('routes then weather, once each, and not again on focus, online or remount', async () => {
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      url === '/api/routes'
        ? json(buildRoutes('mixed', { departure }))
        : json(buildWeather('mixed', { departure })),
    ),
  );
  const submission = newSubmission(trip());
  const { ui, rerender } = setup(submission);

  await waitFor(() => expect(latest.phase).toBe('ready'));
  disturb();
  rerender(ui(submission, 'remounted'));
  disturb();
  await new Promise((r) => setTimeout(r, 50));

  expect(calls(fetchMock, '/api/routes')).toBe(1);
  expect(calls(fetchMock, '/api/weather')).toBe(1);
  expect(latest.explanation?.kind).toBe('decided');
});

test('the weather request carries the routes answer back, without the line', async () => {
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      url === '/api/routes'
        ? json(buildRoutes('mixed', { departure }))
        : json(buildWeather('mixed', { departure })),
    ),
  );
  setup(newSubmission(trip()));
  await waitFor(() => expect(latest.phase).toBe('ready'));
  const weatherCall = fetchMock.mock.calls.find(([url]) => url === '/api/weather')!;
  const body = JSON.parse(weatherCall[1].body as string);
  expect(body.routes[0]).not.toHaveProperty('line');
  expect(body.routes).toHaveLength(3);
});

test('a failed weather request leaves the routes in place and retries only on request', async () => {
  let weatherAnswers = 0;
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/routes') return Promise.resolve(json(buildRoutes('mixed', { departure })));
    weatherAnswers += 1;
    return Promise.resolve(
      weatherAnswers === 1
        ? json({ code: 'provider_limited', message: 'x' }, 503)
        : json(buildWeather('mixed', { departure })),
    );
  });
  setup(newSubmission(trip()));

  await waitFor(() => expect(latest.phase).toBe('weather_error'));
  expect(latest.view?.routes).toHaveLength(3);
  expect(latest.view?.weather).toBe('failed');
  disturb();
  await new Promise((r) => setTimeout(r, 30));
  expect(calls(fetchMock, '/api/weather')).toBe(1);

  act(() => latest.retryWeather());
  await waitFor(() => expect(latest.phase).toBe('ready'));
  expect(calls(fetchMock, '/api/weather')).toBe(2);
  expect(calls(fetchMock, '/api/routes')).toBe(1);
});

test('a new submission cancels the old one in flight and starts clean', async () => {
  const signals: AbortSignal[] = [];
  fetchMock.mockImplementation((_url: string, init: RequestInit) => {
    signals.push(init.signal!);
    return new Promise(() => {}); // never answers
  });
  const first = newSubmission(trip());
  const { ui, rerender } = setup(first);
  await waitFor(() => expect(signals).toHaveLength(1));

  rerender(ui(newSubmission(trip())));
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  expect(latest.phase).toBe('routes_pending');
});

test('an answer that does not line up with the routes is an unknown failure with the routes kept', async () => {
  const bad = buildWeather('mixed', { departure });
  bad.routes.pop();
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(url === '/api/routes' ? json(buildRoutes('mixed', { departure })) : json(bad)),
  );
  setup(newSubmission(trip()));
  await waitFor(() => expect(latest.phase).toBe('weather_error'));
  expect(latest.weatherError?.code).toBe('unknown');
  expect(latest.view?.routes).toHaveLength(3);
});
