import { afterEach, describe, expect, it, vi } from 'vitest';

import { attach, type StreamFrame } from '../sse';

import { eventStream, frame, json, refused, stubApi } from '@/__tests__/harness';
import { ApiError } from '@/lib/api/errors';

/**
 * Reading an event stream off the wire. What is worth testing is everything
 * that is not an event: the keep-alive comments that stop an idle connection
 * being timed out, the half of a frame that arrives in one chunk and the rest of
 * it in the next, and the events a build that shipped last month has never heard
 * of.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const PATH = '/api/v1/messages/aaaaaaaa-0000-4000-8000-000000000000/stream';

async function read(response: Response): Promise<StreamFrame[]> {
  stubApi(() => response);
  const seen: StreamFrame[] = [];
  for await (const item of attach(PATH, null, new AbortController().signal)) seen.push(item);

  return seen;
}

const delta = (text: string) => ({ type: 'text_delta', delta: text });

describe('frames on the wire', () => {
  it('are read with the position each one can be resumed from', async () => {
    const seen = await read(
      eventStream([frame('1-0', delta('Apple')), frame('2-0', delta(' earned'))]),
    );

    expect(seen).toEqual([
      { id: '1-0', event: { type: 'text_delta', delta: 'Apple' } },
      { id: '2-0', event: { type: 'text_delta', delta: ' earned' } },
    ]);
  });

  it('are held until they are whole, however the chunks fall', async () => {
    // A frame split across two reads is the ordinary case, not the exception.
    const whole = frame('1-0', delta('Apple earned $391.0B'));
    const response = eventStream([whole.slice(0, 20), whole.slice(20)]);

    expect(await read(response)).toEqual([
      { id: '1-0', event: { type: 'text_delta', delta: 'Apple earned $391.0B' } },
    ]);
  });

  it('carry no position when the server made the event up', async () => {
    const seen = await read(eventStream([frame(null, { type: 'reconnect_hint' })]));

    // Taking a position from one of these would resume from somewhere that does
    // not exist.
    expect(seen).toEqual([{ id: null, event: { type: 'reconnect_hint' } }]);
  });
});

describe('everything that is not an event', () => {
  it('skips the keep-alive comments', async () => {
    // A comment is what stops an idle connection being timed out by whatever is
    // in the way, and it means nothing to a reader.
    const seen = await read(eventStream([':\n\n', frame('1-0', delta('Apple')), ':\n\n']));

    expect(seen.map((item) => item.id)).toEqual(['1-0']);
  });

  it('skips an event this build cannot read, and keeps going', async () => {
    const seen = await read(
      eventStream([
        frame('1-0', { type: 'from_a_newer_server', detail: 'unknowable' }),
        frame('2-0', delta('Apple')),
      ]),
    );

    // A server that has shipped a new event keeps working with a tab that was
    // opened before it.
    expect(seen.map((item) => item.id)).toEqual(['2-0']);
  });

  it('skips a frame whose data is not JSON at all', async () => {
    const seen = await read(eventStream(['data: not json\n\n', frame('2-0', delta('Apple'))]));

    expect(seen.map((item) => item.id)).toEqual(['2-0']);
  });
});

describe('a stream that does not open', () => {
  it('fails with the refusal the server sent, before anything is read', async () => {
    stubApi(() =>
      refused({ code: 'not_found', message: 'That message does not exist.', status: 404 }),
    );

    // Thrown where the request was made rather than three frames into a loop.
    await expect(attach(PATH, null, new AbortController().signal).next()).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('sends the position the client wants to resume from', async () => {
    const { calls } = stubApi(() => eventStream([]));
    const headers: Record<string, string>[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      headers.push({ ...(init.headers as Record<string, string>) });
      return await original(url, init);
    });

    for await (const _ of attach(PATH, '42-1', new AbortController().signal)) break;

    expect(calls).toHaveLength(1);
    expect(headers[0]?.['last-event-id']).toBe('42-1');
  });

  it('reports a body-less response rather than reading nothing for ever', async () => {
    stubApi(() => new Response(null, { status: 200 }));

    await expect(attach(PATH, null, new AbortController().signal).next()).rejects.toThrow();
  });

  it('says the session ended when the refresh cannot save it', async () => {
    stubApi((url) =>
      url.includes('/auth/refresh')
        ? refused({ code: 'unauthenticated', message: 'Sign in.', status: 401 })
        : refused({ code: 'unauthenticated', message: 'Sign in.', status: 401 }),
    );

    // The application is told once, in the one place that knows what to do with
    // it, rather than every caller discovering it separately.
    await expect(attach(PATH, null, new AbortController().signal).next()).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('reads what a session refresh made possible', async () => {
    let attempts = 0;
    stubApi((url) => {
      if (url.includes('/auth/refresh')) return json({ ok: true });
      attempts += 1;
      // A generation outlives an access token, so a stream reconnecting after
      // fifteen minutes must not be refused for good.
      return attempts === 1
        ? refused({ code: 'unauthenticated', message: 'Sign in.', status: 401 })
        : eventStream([frame('1-0', delta('Apple'))]);
    });

    const seen: StreamFrame[] = [];
    for await (const item of attach(PATH, null, new AbortController().signal)) seen.push(item);

    expect(seen.map((item) => item.id)).toEqual(['1-0']);
  });
});
