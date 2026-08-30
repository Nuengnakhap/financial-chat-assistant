import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows the API as reachable once the probe answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    render(<App />);

    expect(await screen.findByRole('status')).toHaveTextContent('API reachable');
  });

  it('says the API is unreachable rather than staying on the loading text forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    render(<App />);

    expect(await screen.findByRole('status')).toHaveTextContent('API unreachable');
  });

  it('ignores a reply to a request it already abandoned', async () => {
    // StrictMode runs the effect twice in development, which is how this ships:
    // the first request is aborted and the second is the live one. If the
    // abandoned reply is allowed through when it lands late, it overwrites the
    // fresh answer with a stale one — the failure the guard in the effect exists
    // to prevent, and the reason it cannot just be deleted as dead code.
    const replies: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve))),
    );

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(replies).toHaveLength(2);

    replies[1]?.(new Response('{}', { status: 200 }));
    expect(await screen.findByRole('status')).toHaveTextContent('API reachable');

    // Inside `act` so React actually renders whatever the late reply causes.
    // Without it the assertion below passes even when the guard is deleted,
    // because the re-render has not happened yet when it runs.
    await act(async () => {
      replies[0]?.(new Response('', { status: 503 }));
      await Promise.resolve();
    });

    expect(screen.getByRole('status')).toHaveTextContent('API reachable');
  });

  it('aborts the in-flight probe when it unmounts', () => {
    let captured: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        captured = init?.signal ?? undefined;
        // Never settles: the request is still in flight when the unmount happens.
        return new Promise<Response>(() => undefined);
      }),
    );

    const { unmount } = render(<App />);
    expect(captured?.aborted).toBe(false);

    unmount();

    expect(captured?.aborted).toBe(true);
  });
});
