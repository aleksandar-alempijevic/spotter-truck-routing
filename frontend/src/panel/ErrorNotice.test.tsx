import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, type ApiErrorCode } from '../api/client';
import { describeError, type ErrorContext } from '../plan/errors';
import { ErrorNotice } from './ErrorNotice';

afterEach(cleanup);

const CODES: ApiErrorCode[] = [
  'validation_error',
  'not_found',
  'method_not_allowed',
  'internal_error',
  'no_route',
  'provider_timeout',
  'provider_unavailable',
  'provider_limited',
  'provider_not_configured',
  'provider_malformed_response',
  'provider_error',
  'outside_service_area',
  'too_many_locations',
  'unknown',
];
const CONTEXTS: ErrorContext[] = ['routes', 'weather', 'address'];

test.each(CONTEXTS.flatMap((context) => CODES.map((code) => [context, code] as const)))(
  '%s / %s shows its message and exactly the way forward its row names',
  (context, code) => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    const message = describeError(context, new ApiError(code, 'server text', 500));
    render(<ErrorNotice message={message} onRetry={onRetry} onEdit={onEdit} />);

    expect(screen.getByText(message.title)).toBeInTheDocument();
    expect(screen.getByText(message.body)).toBeInTheDocument();
    const retry = screen.queryByRole('button', { name: 'Try again' });
    const edit = screen.queryByRole('button', { name: 'Edit trip' });
    expect(retry !== null).toBe(message.action === 'retry');
    expect(edit !== null).toBe(message.action === 'edit');
    if (retry) fireEvent.click(retry);
    if (edit) fireEvent.click(edit);
    expect(onRetry).toHaveBeenCalledTimes(message.action === 'retry' ? 1 : 0);
    expect(onEdit).toHaveBeenCalledTimes(message.action === 'edit' ? 1 : 0);
    expect(screen.queryByText('server text')).not.toBeInTheDocument();
  },
);
