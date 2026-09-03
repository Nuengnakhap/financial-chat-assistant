import type { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';

import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import { SseStream, type Frame } from '../sse-stream';

/**
 * The list of streams this process has open, and what happens to them when it is
 * asked to stop. Everything about a single connection is proven next door
 * against `SseWriter`; these are the parts that need more than one.
 */

interface Recorder {
  readonly reply: FastifyReply;
  readonly frames: string[];
  accepting: boolean;
  writableLength: number;
  ended: boolean;
}

function recorder(): Recorder {
  const frames: string[] = [];
  const fake = {
    frames,
    accepting: true,
    writableLength: 0,
    ended: false,
    reply: {
      raw: {
        writeHead: () => undefined,
        write: (frame: string) => {
          frames.push(frame);
          return fake.accepting;
        },
        once: () => undefined,
        end: () => {
          fake.ended = true;
        },
        get writableLength() {
          return fake.writableLength;
        },
      } as unknown as ServerResponse,
    } as unknown as FastifyReply,
  };

  return fake;
}

const logs: string[] = [];
const logger = new AppLogger(
  createPinoLogger({
    level: 'debug',
    pretty: false,
    destination: new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    }),
  }),
);

async function* frames(...items: Frame[]): AsyncIterable<Frame> {
  // eslint-disable-next-line no-await-in-loop -- a stream yields in order or it is not a stream
  for (const item of items) yield await Promise.resolve(item);
}

/** Never ends on its own, like a generation that is still being written. */
async function* forever(): AsyncIterable<Frame> {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a stream, paced.
    await new Promise((resolve) => setTimeout(resolve, 5));
    yield { id: null, data: { type: 'text_delta' } };
  }
}

describe('piping events to a reader', () => {
  it('writes them all and ends the response afterwards', async () => {
    const reply = recorder();

    await new SseStream(logger).pipe(reply.reply, frames({ id: '1-0', data: { a: 1 } }));

    expect(reply.frames).toEqual([':\n\n', 'id: 1-0\ndata: {"a":1}\n\n']);
    expect(reply.ended).toBe(true);
  });

  it('stops writing to a reader that has fallen too far behind, and says so', async () => {
    logs.length = 0;
    const reply = recorder();
    reply.writableLength = 2_000_000;

    await new SseStream(logger).pipe(
      reply.reply,
      frames({ id: '1-0', data: { a: 1 } }, { id: '2-0', data: { a: 2 } }),
    );

    // Only the opening comment got through, and nothing after the first refusal.
    expect(reply.frames).toEqual([':\n\n']);
    expect(logs.join('')).toContain('could not keep up');
    expect(reply.ended).toBe(true);
  });
});

describe('a process that is shutting down', () => {
  it('tells every open reader to come back, then lets go', async () => {
    const reply = recorder();
    const stream = new SseStream(logger);
    const piping = stream.pipe(reply.reply, forever());
    await new Promise((resolve) => setTimeout(resolve, 10));

    await stream.windDown();

    // The generation is untouched either way; this is only about how long the
    // screen sits still before the client reattaches.
    expect(reply.frames.at(-1)).toBe('data: {"type":"reconnect_hint"}\n\n');
    expect(reply.ended).toBe(true);
    await Promise.race([piping, new Promise((resolve) => setTimeout(resolve, 20))]);
  });

  it('has nothing to say when nobody is reading', async () => {
    await expect(new SseStream(logger).windDown()).resolves.toBeUndefined();
  });

  it('does not tell a reader that has already gone', async () => {
    const reply = recorder();
    const stream = new SseStream(logger);
    await stream.pipe(reply.reply, frames({ id: '1-0', data: { a: 1 } }));

    await stream.windDown();

    // A stream that finished is off the list: writing to it would be writing to
    // a response that has already ended.
    expect(reply.frames.at(-1)).toBe('id: 1-0\ndata: {"a":1}\n\n');
  });
});
