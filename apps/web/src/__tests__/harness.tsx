import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';

const USER = {
  id: '9f1b7c2e-0d3a-4f5b-8c6d-7e8f9a0b1c2d',
  email: 'ada@example.com',
  displayName: 'Ada',
  createdAt: '2026-08-30T10:00:00.000Z',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

export function signedIn(): Response {
  return json({ user: USER });
}

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
}

export function refused({ code, message, status, headers = {} }: Refusal): Response {
  return json(
    { code, message, requestId: '2f1c2a1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b' },
    status,
    headers,
  );
}

export function signedOut(): Response {
  return refused({
    code: 'unauthenticated',
    message: 'You need to sign in to do that.',
    status: 401,
  });
}

type Answer = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Stubs `fetch` with a function that decides per URL, and reports what was asked. */
export function stubApi(answer: Answer): { readonly calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return await answer(url, init);
    }),
  );
  return { calls };
}

/**
 * The tree a screen actually renders inside. A fresh `QueryClient` per call, so
 * one test's cache is never another's starting state, and `retry: false` so a
 * refusal is an answer rather than three seconds of backoff.
 */
export function renderApp(
  ui: ReactNode,
  route = '/',
): RenderResult & { readonly queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </QueryClientProvider>,
    ),
    queryClient,
  };
}
