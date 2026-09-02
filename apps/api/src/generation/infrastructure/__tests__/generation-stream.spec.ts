import type { StreamEvent } from '@fca/contracts';
import { MessageId } from '@fca/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncQueue } from '../../../shared/async/async-queue';
import type { RedisService } from '../../../shared/redis/redis.service';
import type { StreamMultiplexer } from '../../../shared/redis/stream-multiplexer';
import type { StreamEntry } from '../../../shared/redis/stream-reader';
import {
  STREAM_START,
  type StoredStreamEvent,
} from '../../application/ports/generation-events.port';
import { GenerationStream } from '../generation-stream';

/**
 * What the reader does with what it is given, with Redis replaced. The parts
 * that are properties of Redis itself are proven next door against a real one;
 * these are the decisions this file makes on its own — which entries it hands on,
 * which it drops, and how it ends.
 */

const ANSWER = MessageId.trusted('a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d');

const entry = (id: string, event: StreamEvent): StreamEntry => ({
  id,
  payload: JSON.stringify(event),
});
const text = (delta: string): StreamEvent => ({ type: 'text_delta', delta });
const done: StreamEvent = { type: 'error', code: 'generation_failed', message: 'no' };

const readStreamAfter = vi.fn();
const endOfStream = vi.fn();
const appendToStream = vi.fn();
const closeSubscription = vi.fn();
const subscribe = vi.fn();
let queue: AsyncQueue<StreamEntry>;

const redis = { readStreamAfter, endOfStream, appendToStream } as unknown as RedisService;
const streams = { subscribe } as unknown as StreamMultiplexer;

let stream: GenerationStream;

beforeEach(() => {
  vi.resetAllMocks();
  queue = new AsyncQueue<StreamEntry>(4);
  stream = new GenerationStream(redis, streams);
  readStreamAfter.mockResolvedValue([]);
  endOfStream.mockResolvedValue(STREAM_START);
  appendToStream.mockResolvedValue('1-0');
  subscribe.mockResolvedValue({ entries: queue, close: closeSubscription });
});

async function readAll(afterId = STREAM_START): Promise<readonly StoredStreamEvent[]> {
  const seen: StoredStreamEvent[] = [];
  for await (const stored of stream.read(ANSWER, afterId, new AbortController().signal)) {
    seen.push(stored);
  }

  return seen;
}

describe('an entry that arrives twice', () => {
  it('is handed on once, because the id says it has been seen', async () => {
    // The replay and the live tail overlap on purpose — a stream already being
    // tailed for someone else starts behind where this reader has got to.
    readStreamAfter.mockResolvedValueOnce([entry('1-0', text('one'))]).mockResolvedValue([]);
    queue.push(entry('1-0', text('one')));
    queue.push(entry('2-0', done));

    const seen = await readAll();

    expect(seen.map((stored) => stored.id)).toEqual(['1-0', '2-0']);
  });

  it('compares the two halves of an id as numbers, not as text', async () => {
    // `10-0` is before `9-0` as a string, so a stream that has been going for
    // ten milliseconds would start dropping everything it read.
    queue.push(entry('9-0', text('ninth')));
    queue.push(entry('10-0', done));

    expect((await readAll()).map((stored) => stored.id)).toEqual(['9-0', '10-0']);
  });
});

describe('an entry this build cannot read', () => {
  it('is skipped rather than ending the stream', async () => {
    // A stream outlives a deployment: an event written by a newer process can
    // be sitting in one that an older process is reading.
    readStreamAfter
      .mockResolvedValueOnce([
        { id: '1-0', payload: 'not json at all' },
        { id: '2-0', payload: JSON.stringify({ type: 'from_the_future' }) },
        entry('3-0', done),
      ])
      .mockResolvedValue([]);

    expect((await readAll()).map((stored) => stored.event.type)).toEqual(['error']);
  });
});

describe('a reader that has fallen too far behind', () => {
  it('is told to reattach, with no id to move its cursor to', async () => {
    for (const index of [1, 2, 3, 4, 5]) queue.push(entry(`${String(index)}-0`, text('x')));

    const seen = await readAll();

    // The event is this process speaking, not something in the stream. Giving
    // it an id would move the client's cursor past events it never received.
    expect(seen).toEqual([{ id: null, event: { type: 'reconnect_hint' } }]);
  });
});

describe('the end of a generation', () => {
  it('stops the reader even when the live tail keeps going', async () => {
    queue.push(entry('1-0', done));
    queue.push(entry('2-0', text('after the end')));

    expect((await readAll()).map((stored) => stored.id)).toEqual(['1-0']);
  });

  it('lets go of the subscription however the reading ended', async () => {
    queue.push(entry('1-0', done));

    await readAll();

    // Without this the multiplexer keeps a stream in its next read for every
    // connection that has ever attached to it.
    expect(closeSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('a client that says where it got to', () => {
  it('asks only for what comes after that, and never from the beginning', async () => {
    queue.push(entry('7-0', done));

    await readAll('5-3');

    expect(readStreamAfter).toHaveBeenCalledWith(expect.any(String), '5-3', expect.any(Number));
  });
});

describe('the order the two paths are opened in', () => {
  it('attaches to the live tail before replaying a single entry', async () => {
    queue.push(entry('1-0', done));

    await readAll();

    // The whole correctness of resuming rests on this. Replaying first leaves a
    // window between the last entry read and the tail being attached, and an
    // event that lands in it reaches neither path — a delta missing from the
    // middle of an answer, which reads as a finished sentence with a word gone.
    const attached = subscribe.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const replayed = readStreamAfter.mock.invocationCallOrder[0] ?? 0;
    expect(attached).toBeLessThan(replayed);
  });
});

describe('when a generation was last heard from', () => {
  it('is read out of the id of the last entry, which is when Redis wrote it', async () => {
    endOfStream.mockResolvedValue('1788335150529-3');

    await expect(stream.lastActivityAt(ANSWER)).resolves.toEqual(new Date(1_788_335_150_529));
  });

  it('is nothing at all for a generation that has produced nothing yet', async () => {
    // Which is not the same as "not alive": the caller falls back to when the
    // row was written, because a runner waiting on a first token is healthy.
    endOfStream.mockResolvedValue(STREAM_START);

    await expect(stream.lastActivityAt(ANSWER)).resolves.toBeNull();
  });
});

describe('reading a stream without waiting for more', () => {
  it('takes everything on it as it stands', async () => {
    readStreamAfter
      .mockResolvedValueOnce([entry('1-0', text('one')), entry('2-0', done)])
      .mockResolvedValue([]);

    const seen = await stream.replay(ANSWER);

    expect(seen.map((stored) => stored.id)).toEqual(['1-0', '2-0']);
  });

  it('answers with nothing for a stream that has expired', async () => {
    await expect(stream.replay(ANSWER)).resolves.toEqual([]);
  });
});

describe('writing an event', () => {
  it('keeps the stream bounded and gives it a life of its own', async () => {
    await stream.append(ANSWER, done);

    // Trimmed by length and expiring after the last event: a generation is
    // watched for minutes and the row it ends in is kept for good.
    expect(appendToStream).toHaveBeenCalledWith(expect.any(String), JSON.stringify(done), {
      maxLength: 4_096,
      ttlSeconds: 1_800,
    });
  });
});
