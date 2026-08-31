import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * `retry: false` everywhere on purpose. `apiFetch` already refreshes once and
 * retries once when a token has expired, which is the only retry that recovers
 * anything here; a second layer of them would repeat requests the server has
 * just refused, including one it refused for being too frequent.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: true, staleTime: 30_000 },
      mutations: { retry: false },
    },
  });
}

export function Providers({ children }: { readonly children: ReactNode }) {
  // Created once per mount rather than at module scope: a module-level client is
  // shared by every test in a file, and one test's cache becomes the next one's
  // starting state.
  const [queryClient] = useState(createQueryClient);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
