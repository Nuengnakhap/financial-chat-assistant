import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { MemoryRouter, type InitialEntry } from 'react-router';
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

/**
 * An event stream as a response, written the way the server writes one. The
 * frames are handed over one at a time so a test can watch an answer arrive
 * rather than see all of it at once, which is the only way to observe what the
 * screen looks like halfway through.
 */
export function eventStream(frames: readonly string[], hold = false): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      // Left open, the way a generation that has not finished leaves it.
      if (!hold) controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * A stream a test writes to as it goes, for the things that only happen while
 * one is open — following the end of a conversation, a chip appearing halfway.
 */
export function pushableStream(): {
  readonly response: Response;
  push: (frame: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
  });

  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (frame: string) => sink?.enqueue(encoder.encode(frame)),
    close: () => sink?.close(),
  };
}

/** One frame of a stream, with the position a client would resume from. */
export function frame(id: string | null, event: unknown): string {
  return `${id === null ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`;
}

type Answer = (url: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * Stubs `fetch` with a function that decides per URL, and reports what was asked.
 *
 * The signal is honoured, because the real one is: a request whose caller has
 * gone away fails rather than handing back a response nobody is waiting for. A
 * stub that answered anyway would let a page that had already been torn down go
 * on dispatching what it read, which is a whole class of lifecycle fault no test
 * could see.
 */
export function stubApi(answer: Answer): { readonly calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const response = await answer(url, init);
      // Checked after the answer as well as before it: an abort while a request
      // is in flight is the ordinary case, not the exception.
      if (init?.signal?.aborted === true) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      return response;
    }),
  );
  return { calls };
}

/**
 * A cache of its own, which is what every test wants: one test's cache is never
 * another's starting state. Handed out separately for the tests that want the
 * opposite — a screen opened a second time with what the first one read still in
 * hand, which is how somebody comes back to a conversation.
 */
export function freshCache(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * The tree a screen actually renders inside. `retry: false` so a refusal is an
 * answer rather than three seconds of backoff.
 */
export function renderApp(
  ui: ReactNode,
  route: InitialEntry = '/',
  queryClient: QueryClient = freshCache(),
): RenderResult & { readonly queryClient: QueryClient } {
  return {
    ...render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    ),
    queryClient,
  };
}
