import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CrashNotice } from './CrashNotice';
import { ErrorBoundary } from './ErrorBoundary';

beforeEach(() => {
  // React reports an error a boundary catches; that is the boundary working.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Broken(): never {
  throw new Error('broke while rendering');
}

test('a child that throws is replaced by the fallback, and its siblings stay', () => {
  render(
    <>
      <p>the rest of the page</p>
      <ErrorBoundary fallback={<p>fallback shown</p>}>
        <Broken />
      </ErrorBoundary>
    </>,
  );
  expect(screen.getByText('fallback shown')).toBeInTheDocument();
  expect(screen.getByText('the rest of the page')).toBeInTheDocument();
});

test('children that render are left alone', () => {
  render(
    <ErrorBoundary fallback={<p>fallback shown</p>}>
      <p>fine</p>
    </ErrorBoundary>,
  );
  expect(screen.getByText('fine')).toBeInTheDocument();
  expect(screen.queryByText('fallback shown')).not.toBeInTheDocument();
});

test('the crash notice says what happened and reloads the page on request', () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  render(
    <ErrorBoundary fallback={<CrashNotice />}>
      <Broken />
    </ErrorBoundary>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(reload).toHaveBeenCalledTimes(1);
});
