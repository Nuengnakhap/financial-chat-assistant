import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, NetworkError } from '../errors';
import { apiFetch } from '../http';
import { onSessionExpired } from '../session-expiry';

const REFRESH = '/api/v1/auth/refresh';
const RESOURCE = '/api/v1/auth/me';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

interface Failure {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
}

function failure({ code, message, status, headers = {} }: Failure): Response {
  return json(
    { code, message, requestId: '2f1c2a1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b' },
    status,
    headers,
  );
}

function urlOf(input: unknown): string {
  return typeof input === 'string' ? input : String(input);
}

beforeEach(() => {
  document.cookie = 'fca_csrf=token-from-cookie';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'fca_csrf=; max-age=0';
});

describe('a request', () => {
  it('sends the cookies and echoes the CSRF cookie in a header', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(json({ ok: true })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch({ method: 'GET', path: RESOURCE });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toMatchObject({ 'x-csrf-token': 'token-from-cookie' });
  });

  it('echoes the header on a read as well, because the guard follows the cookie', async () => {
    // The server checks whenever a session cookie is present rather than for a
    // list of routes, so "only on mutations" is a rule with an exception in it.
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(json({ ok: true })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch({ method: 'GET', path: RESOURCE });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-csrf-token': 'token-from-cookie',
    });
  });

  it('returns the parsed body of a success', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json({ user: { id: 'u1' } })));

    await expect(apiFetch({ method: 'GET', path: RESOURCE })).resolves.toEqual({
      user: { id: 'u1' },
    });
  });
});

describe('a failure', () => {
  it('carries the code, the status and the wording the server chose', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(failure({ code: 'not_found', message: 'That does not exist.', status: 404 })),
    );

    await expect(apiFetch({ method: 'GET', path: RESOURCE })).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      message: 'That does not exist.',
    });
  });

  it('reads Retry-After, which is what a countdown needs', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        failure({
          code: 'rate_limited',
          message: 'Too many attempts.',
          status: 429,
          headers: { 'retry-after': '52' },
        }),
      ),
    );

    await expect(apiFetch({ method: 'POST', path: RESOURCE })).rejects.toMatchObject({
      retryAfterSeconds: 52,
    });
  });

  it('ignores a Retry-After it cannot read as seconds', async () => {
    // The header may carry an HTTP date. A countdown from NaN is worse than no
    // countdown, so the field stays absent and the caller shows no clock.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        failure({
          code: 'rate_limited',
          message: 'Too many attempts.',
          status: 429,
          headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
        }),
      ),
    );

    const error = await apiFetch({ method: 'POST', path: RESOURCE }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429 });
    expect((error as ApiError).retryAfterSeconds).toBeUndefined();
  });

  it('still reports a status when the body is not the envelope', async () => {
    // A proxy answering 502 never reached the error filter, so there is no code
    // to read — but the status is real and swallowing it would look like success.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('<html>502</html>', { status: 502 })),
    );

    const error = await apiFetch({ method: 'GET', path: RESOURCE }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'internal', status: 502 });
  });

  it('lets an abort through instead of calling it a network failure', async () => {
    // Reporting the caller's own cancellation as "cannot reach the server" would
    // put an error on screen every time a route changes.
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const aborted = new Error('The operation was aborted.');
            aborted.name = 'AbortError';
            reject(aborted);
          });
        });
      }),
    );
    const controller = new AbortController();

    const pending = apiFetch({ method: 'GET', path: RESOURCE, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.not.toBeInstanceOf(NetworkError);
  });

  it('separates unreachable from refused', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));

    await expect(apiFetch({ method: 'GET', path: RESOURCE })).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('a 401', () => {
  it('refreshes once and retries the request once', async () => {
    let resourceCalls = 0;
    const fetchMock = vi.fn((input: unknown) => {
      const url = urlOf(input);
      if (url === REFRESH) return Promise.resolve(json({ ok: true }));
      resourceCalls += 1;
      return Promise.resolve(
        resourceCalls === 1
          ? failure({
              code: 'unauthenticated',
              message: 'You need to sign in to do that.',
              status: 401,
            })
          : json({ user: { id: 'u1' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch({ method: 'GET', path: RESOURCE })).resolves.toEqual({
      user: { id: 'u1' },
    });
    expect(resourceCalls).toBe(2);
  });

  it('does not refresh a second time when the retry is refused too', async () => {
    // A second 401 after a good refresh is not an expired token, and repeating
    // is a loop rather than a recovery.
    let refreshCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        if (urlOf(input) === REFRESH) {
          refreshCalls += 1;
          return Promise.resolve(json({ ok: true }));
        }
        return Promise.resolve(
          failure({ code: 'unauthenticated', message: 'Sign in.', status: 401 }),
        );
      }),
    );

    await expect(apiFetch({ method: 'GET', path: RESOURCE })).rejects.toMatchObject({
      status: 401,
    });
    expect(refreshCalls).toBe(1);
  });

  it('announces the end of the session when the refresh is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        Promise.resolve(
          urlOf(input) === REFRESH
            ? failure({ code: 'unauthenticated', message: 'Sign in.', status: 401 })
            : failure({ code: 'unauthenticated', message: 'Sign in.', status: 401 }),
        ),
      ),
    );
    const expired = vi.fn();
    const stop = onSessionExpired(expired);

    await expect(apiFetch({ method: 'GET', path: RESOURCE })).rejects.toMatchObject({
      status: 401,
    });

    expect(expired).toHaveBeenCalledTimes(1);
    stop();
  });

  it('treats a refresh that never answers as a refresh that failed', async () => {
    // The network can drop between the 401 and the refresh. Anything other than
    // a successful rotation has to end the session rather than retry blindly.
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        urlOf(input) === REFRESH
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(failure({ code: 'unauthenticated', message: 'Sign in.', status: 401 })),
      ),
    );
    const expired = vi.fn();
    const stop = onSessionExpired(expired);

    await expect(apiFetch({ method: 'GET', path: RESOURCE })).rejects.toMatchObject({
      status: 401,
    });

    expect(expired).toHaveBeenCalledTimes(1);
    stop();
  });

  it('shares one refresh between everything that got a 401 at the same time', async () => {
    // The refresh token rotates on every use. Five refreshes present the same
    // token five times, and the server reads a token presented twice as stolen
    // and revokes the lineage — so racing here signs the person out.
    let refreshCalls = 0;
    const seen = new Map<string, number>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = urlOf(input);
        if (url === REFRESH) {
          refreshCalls += 1;
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(json({ ok: true }));
            }, 5);
          });
        }
        const attempt = (seen.get(url) ?? 0) + 1;
        seen.set(url, attempt);
        return Promise.resolve(
          attempt === 1
            ? failure({ code: 'unauthenticated', message: 'Sign in.', status: 401 })
            : json({ ok: true }),
        );
      }),
    );

    const paths = [
      '/api/v1/auth/me',
      '/api/v1/auth/sessions',
      '/api/v1/a',
      '/api/v1/b',
      '/api/v1/c',
    ];
    await Promise.all(paths.map(async (path) => await apiFetch({ method: 'GET', path })));

    expect(refreshCalls).toBe(1);
  });

  it('does not refresh after a refused sign-in', async () => {
    // A wrong password is not an expired token. Refreshing spends a request to
    // be refused again, and announces an expiry to someone who never had a
    // session — seen in the browser as a second 401 in the console.
    const fetchMock = vi.fn(() =>
      Promise.resolve(failure({ code: 'unauthenticated', message: 'no', status: 401 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      apiFetch({ method: 'POST', path: '/api/v1/auth/login', body: {} }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call a broken cookie an unreachable server', async () => {
    // Ports share a cookie jar, so anything else on localhost can leave a value
    // under this name that is not valid percent-encoding. Reading it happens
    // inside the same try that catches a failed fetch, so an unguarded decode
    // put "cannot reach the server" on screen for a server that was answering.
    document.cookie = 'fca_csrf=%';
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(json({ ok: true })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch({ method: 'GET', path: RESOURCE })).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-csrf-token': '%' });
    document.cookie = 'fca_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });
});
