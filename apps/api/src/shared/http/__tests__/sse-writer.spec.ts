import type { ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { SseWriter } from '../sse-writer';

/**
 * Writing to a socket that may not be keeping up. Ignoring what `write` returns
 * is how one phone on a weak signal becomes unbounded memory in this process, so
 * every branch here is about noticing.
 */

interface FakeResponse {
  readonly response: ServerResponse;
  readonly frames: string[];
  readonly head: { status: number; headers: Record<string, string> } | null;
  writableLength: number;
  accepting: boolean;
  ended: boolean;
  drain(): void;
  cut(): void;
}

function fakeResponse(): FakeResponse {
  const frames: string[] = [];
  const listeners = new Map<string, (() => void)[]>();
  const fake = {
    frames,
    head: null as { status: number; headers: Record<string, string> } | null,
    writableLength: 0,
    accepting: true,
    ended: false,
    drain: () => {
      for (const listener of listeners.get('drain') ?? []) listener();
      listeners.delete('drain');
    },
    cut: () => {
      for (const listener of listeners.get('close') ?? []) listener();
      listeners.delete('close');
    },
    response: {
      writeHead: (status: number, headers: Record<string, string>) => {
        fake.head = { status, headers };
      },
      write: (frame: string) => {
        frames.push(frame);
        return fake.accepting;
      },
      once: (event: string, listener: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      end: () => {
        fake.ended = true;
      },
      get writableLength() {
        return fake.writableLength;
      },
    } as unknown as ServerResponse,
  };

  return fake;
}

describe('opening a stream', () => {
  it('says it is one, and that nothing in the way may buffer it', () => {
    const fake = fakeResponse();

    new SseWriter(fake.response).open();

    expect(fake.head?.status).toBe(200);
    // A proxy that compresses buffers, and a buffered event stream arrives all
    // at once at the end — which is not a stream.
    expect(fake.head?.headers).toMatchObject({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    // Some proxies forward nothing until the first byte arrives.
    expect(fake.frames).toEqual([':\n\n']);
  });
});

describe('writing an event', () => {
  it('carries the id a client would resume from', async () => {
    const fake = fakeResponse();

    await new SseWriter(fake.response).write('7-0', { type: 'text_delta', delta: 'Apple' });

    expect(fake.frames).toEqual(['id: 7-0\ndata: {"type":"text_delta","delta":"Apple"}\n\n']);
  });

  it('leaves the id out for something the server made up', async () => {
    const fake = fakeResponse();

    await new SseWriter(fake.response).write(null, { type: 'reconnect_hint' });

    // An id here would move the client's cursor to a position that does not
    // exist, and it would resume from the wrong place.
    expect(fake.frames).toEqual(['data: {"type":"reconnect_hint"}\n\n']);
  });

  it('waits for the socket to drain before writing again', async () => {
    const fake = fakeResponse();
    fake.accepting = false;
    const writer = new SseWriter(fake.response);

    const writing = writer.write('1-0', { type: 'reconnect_hint' });
    const settled = vi.fn();
    void writing.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    fake.drain();

    expect(await writing).toBe(true);
  });

  it('stops waiting when the socket closes instead of draining', async () => {
    // A closed socket never drains, and a wait for one is a wait for ever.
    const fake = fakeResponse();
    fake.accepting = false;
    const writing = new SseWriter(fake.response).write('1-0', { type: 'reconnect_hint' });

    fake.cut();

    expect(await writing).toBe(true);
  });

  it('gives up on a reader that has fallen a megabyte behind', async () => {
    const fake = fakeResponse();
    fake.writableLength = 1_000_001;

    const written = await new SseWriter(fake.response).write('1-0', { type: 'reconnect_hint' });

    // False tells the caller to stop. Nothing else is written, and the reader
    // resumes by id — the generation itself is untouched either way.
    expect(written).toBe(false);
    expect(fake.frames).toEqual([]);
  });
});

describe('keeping a quiet connection alive', () => {
  it('sends a comment nothing reads', () => {
    const fake = fakeResponse();

    new SseWriter(fake.response).keepAlive();

    expect(fake.frames).toEqual([':\n\n']);
  });

  it('ends the response when the stream is over', () => {
    const fake = fakeResponse();

    new SseWriter(fake.response).end();

    expect(fake.ended).toBe(true);
  });
});
