import { QueryClient } from '@tanstack/react-query';

/**
 * The one policy every query shares: no automatic retry and no refetch on focus. The planning
 * queries add to it (see `queries.ts`) because their cost is what makes it matter.
 */
export const NO_REFETCH = { retry: false, refetchOnWindowFocus: false } as const;

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { ...NO_REFETCH, staleTime: 60_000 } } });
}
