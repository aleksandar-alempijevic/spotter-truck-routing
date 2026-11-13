import { QueryClient } from '@tanstack/react-query';

/**
 * No query in this app wants an automatic retry or a refetch on focus, so the defaults say so.
 * The planning queries repeat it (see `queries.ts`) because their cost is what makes it matter.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 60_000 } },
  });
}
