import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_KEY, useSignOut } from '../api/session';

import { json, stubApi } from '@/__tests__/harness';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signing out', () => {
  it('leaves the session answered and nothing else behind', async () => {
    // Whatever the previous person read is still in the cache, and the next one
    // on this machine would be shown it.
    stubApi(() => json({ ok: true }));
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    queryClient.setQueryData(['conversations'], ['a private conversation']);
    queryClient.setQueryData(SESSION_KEY, { status: 'signed-in' });

    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSignOut(), { wrapper });
    result.current.mutate();

    await waitFor(() => {
      expect(queryClient.getQueryData(SESSION_KEY)).toEqual({ status: 'signed-out' });
    });
    expect(queryClient.getQueryData(['conversations'])).toBeUndefined();
  });
});
