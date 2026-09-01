import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../client';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const USER = {
  id: '9f1b7c2e-0d3a-4f5b-8c6d-7e8f9a0b1c2d',
  email: 'ada@example.com',
  displayName: 'Ada',
  createdAt: '2026-08-30T10:00:00.000Z',
};

beforeEach(() => {
  document.cookie = 'fca_csrf=token-from-cookie';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the client built from the contracts', () => {
  it('calls the path and the verb the contract declares', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(json({ user: USER })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.auth.me();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/me');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('hands the caller signal to the request', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(json({ user: USER })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await api.auth.me({ signal: controller.signal });

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('fills a path parameter and escapes it', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(json({ ok: true })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.auth.revokeSession({ params: { id: 'a b/c' } });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/sessions/a%20b%2Fc');
  });

  it('sends the body as JSON', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(json({ user: USER })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.auth.login({ body: { email: 'ada@example.com', password: 'correct-horse-battery' } });

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      '{"email":"ada@example.com","password":"correct-horse-battery"}',
    );
  });

  it('refuses to build a path it has no value for', async () => {
    // The types make this unreachable from application code; the guard is for
    // the day somebody builds the arguments dynamically.
    vi.stubGlobal('fetch', () => Promise.resolve(json({ ok: true })));
    const untyped = api.auth.revokeSession as (args: {
      params: Record<string, string>;
    }) => Promise<unknown>;

    await expect(untyped({ params: {} })).rejects.toThrow(/needs a "id" parameter/);
  });

  it('sends a body to an endpoint that declares one, even an empty one', async () => {
    // `logout` declares `z.object({})`. Sending no body to a route that parses
    // JSON is a 400 — caught against the real server after a mocked 200 had
    // hidden it for a whole milestone.
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(json({ ok: true })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.auth.logout();

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe('{}');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('declares no content type when it sends nothing', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(json({ user: USER })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.auth.me();

    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('content-type');
  });

  it('parses the answer with the contract, dropping what it does not know', async () => {
    // A server that adds a field stays compatible with a client that has not
    // shipped: unknown keys are stripped rather than rejected.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ user: { ...USER, experimentalField: 'ignored' } })),
    );

    const answer = await api.auth.me();

    expect(answer.user).not.toHaveProperty('experimentalField');
    expect(answer.user.displayName).toBe('Ada');
  });

  it('refuses an answer that does not match the contract', async () => {
    // Better a loud failure here than a `displayName` of undefined rendered
    // into the page three components later.
    vi.stubGlobal('fetch', () => Promise.resolve(json({ user: { id: 'not-a-uuid' } })));

    await expect(api.auth.me()).rejects.toThrow();
  });
});

describe('a query string', () => {
  const emptyPage = () => json({ items: [], nextCursor: null });

  const urlOf = async (call: () => Promise<unknown>): Promise<string> => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        asked.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(emptyPage());
      }),
    );
    await call();

    return asked[0] ?? '';
  };

  it('is left off entirely when nothing was asked for', async () => {
    expect(await urlOf(async () => await api.conversations.list())).toBe('/api/v1/conversations');
  });

  it('carries what was asked for', async () => {
    const url = await urlOf(async () => await api.conversations.list({ query: { limit: 20 } }));

    expect(url).toBe('/api/v1/conversations?limit=20');
  });

  it('leaves out a field with no value, rather than sending the word null', async () => {
    // The first page has no cursor. Sent as `cursor=null` the server would try
    // to decode the word and answer 400 for a request that was fine.
    const url = await urlOf(
      async () => await api.conversations.list({ query: { limit: 20, cursor: null } }),
    );

    expect(url).toBe('/api/v1/conversations?limit=20');
  });

  it('escapes a cursor whatever the server put in it', async () => {
    const url = await urlOf(
      async () => await api.conversations.list({ query: { cursor: 'a b&c=d' } }),
    );

    expect(url).toBe('/api/v1/conversations?cursor=a+b%26c%3Dd');
  });

  it('goes on the end of a path that already had a parameter filled in', async () => {
    const url = await urlOf(
      async () =>
        await api.conversations.listMessages({
          params: { id: '11111111-1111-4111-8111-111111111111' },
          query: { limit: 5 },
        }),
    );

    expect(url).toBe('/api/v1/conversations/11111111-1111-4111-8111-111111111111/messages?limit=5');
  });
});

describe('the types', () => {
  it('rejects every wrong call at compile time', () => {
    // Declared and never called. `@ts-expect-error` fails the build if the line
    // below it stops being an error, so `pnpm typecheck` is the assertion and
    // running this would only make real requests.
    const wrongCalls = (): void => {
      // @ts-expect-error the login body needs a password
      void api.auth.login({ body: { email: 'ada@example.com' } });
      // @ts-expect-error revoking a session needs the id from the path
      void api.auth.revokeSession();
      // @ts-expect-error reading the current user takes no arguments
      void api.auth.me({ body: {} });
      // @ts-expect-error there is no such endpoint in the contract
      void api.auth.notAnEndpoint;
    };

    expect(wrongCalls).toBeTypeOf('function');
  });

  it('refuses an answer whose status the contract did not promise', async () => {
    // `register` says 201. A 200 here means something is answering that is not
    // the route the contract describes, and its body is about to be parsed as
    // though it were.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({ user: USER }))),
    );

    await expect(
      api.auth.register({
        body: { displayName: 'Ada', email: 'a@b.co', password: 'x'.repeat(12) },
      }),
    ).rejects.toMatchObject({ code: 'internal', status: 200 });
  });

  it('accepts the status the contract does promise', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({ user: USER }, 201))),
    );

    await expect(
      api.auth.register({
        body: { displayName: 'Ada', email: 'a@b.co', password: 'x'.repeat(12) },
      }),
    ).resolves.toMatchObject({ user: { email: USER.email } });
  });
});
