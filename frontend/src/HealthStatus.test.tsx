import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { HealthStatus } from './HealthStatus';

function renderStatus() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <HealthStatus />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

test('shows the status returned by the API', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: 'ok' })));
  renderStatus();

  expect(await screen.findByText('API status: ok')).toBeInTheDocument();
});

test('shows an error when the API is unreachable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  renderStatus();

  expect(await screen.findByText(/Cannot reach the API/)).toHaveTextContent('make backend');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

test('retry asks the API again and shows the result', async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(Response.json({ status: 'ok' }));
  vi.stubGlobal('fetch', fetchMock);
  renderStatus();

  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

  expect(await screen.findByText('API status: ok')).toBeInTheDocument();
});
