import { MessageId } from '@fca/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskRegistry } from '../../../bootstrap/task-registry';
import { delay } from '../../async/timeouts';
import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import { K, type RedisKey } from '../keys';
import type { RedisService } from '../redis.service';
import { StreamMultiplexer, type StreamSubscription } from '../stream-multiplexer';
import type { StreamEntry, StreamReadRequest, StreamSlice } from '../stream-reader';

/**
 * How many connections a pod spends on watching, and which streams it asks
 * about. Redis is replaced here: what is under test is the bookkeeping — one
 * blocking read shared by everyone, a stream tracked from where it had got to,
 * and a stream nobody is watching leaving the next read.
 */

const FIRST = K.streamBuffer(MessageId.trusted('a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d'));
const SECOND = K.streamBuffer(MessageId.trusted('b2e1d4c3-5c6f-4b7a-8d9e-1f2a3b4c5d6e'));

const entry = (id: string): StreamEntry => ({ id, payload: '{}' });

const read = vi.fn();
const closeReader = vi.fn();
const endOfStream = vi.fn();
const createStreamReader = vi.fn();

const redis = { endOfStream, createStreamReader } as unknown as RedisService;
const silent = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

let tasks: TaskRegistry;
let streams: StreamMultiplexer;
let open: StreamSubscription[];

/** The cursors each blocking read was made with, in order. */
const cursorsAsked = (): ReadonlyMap<RedisKey, string>[] =>
  read.mock.calls.map((call: readonly unknown[]) => {
    const [request] = call;
    return isRequest(request) ? request.cursors : new Map<RedisKey, string>();
  });

function isRequest(value: unknown): value is StreamReadRequest {
  return typeof value === 'object' && value !== null && 'cursors' in value;
}

beforeEach(() => {
  vi.resetAllMocks();
  read.mockImplementation(async (): Promise<readonly StreamSlice[]> => {
    // Stands in for `BLOCK`: without a pause the loop would spin the event loop
    // faster than a test can observe it.
    await delay(5);
    return [];
  });
  endOfStream.mockResolvedValue('0-0');
  createStreamReader.mockReturnValue({ read, close: closeReader });
  tasks = new TaskRegistry(silent);
  streams = new StreamMultiplexer(redis, tasks, silent);
  open = [];
});

afterEach(async () => {
  for (const subscription of open) subscription.close();
  await streams.onModuleDestroy();
  await tasks.drain(100);
});

async function watch(key: RedisKey): Promise<StreamSubscription> {
  const subscription = await streams.subscribe(key);
  open.push(subscription);

  return subscription;
}

async function collect(subscription: StreamSubscription, count: number): Promise<string[]> {
  const ids: string[] = [];
  for await (const item of subscription.entries.drain(new AbortController().signal)) {
    ids.push(item.id);
    if (ids.length === count) return ids;
  }

  return ids;
}

describe('watching one stream', () => {
  it('hands on what the blocking read brings back', async () => {
    read.mockImplementationOnce(async () => {
      await delay(1);
      return [{ key: FIRST, entries: [entry('1-0'), entry('2-0')] }];
    });

    const subscription = await watch(FIRST);

    expect(await collect(subscription, 2)).toEqual(['1-0', '2-0']);
  });

  it('starts at wherever the stream had already got to', async () => {
    // Not at the beginning: the caller replays that part itself, and delivering
    // it twice would fill the queue with what it is already reading.
    endOfStream.mockResolvedValue('7-3');

    await watch(FIRST);
    await delay(20);

    expect(cursorsAsked()[0]?.get(FIRST)).toBe('7-3');
  });

  it('moves on from the last entry it read', async () => {
    read.mockImplementationOnce(async () => {
      await delay(1);
      return [{ key: FIRST, entries: [entry('1-0'), entry('4-2')] }];
    });

    await watch(FIRST);
    await delay(30);

    // Asking again from the old position would deliver the same entries for as
    // long as the generation lasted.
    expect(cursorsAsked().at(-1)?.get(FIRST)).toBe('4-2');
  });
});

describe('two people watching the same answer', () => {
  it('costs one connection and one place in the read', async () => {
    const first = await watch(FIRST);
    const second = await watch(FIRST);
    read.mockImplementation(async () => {
      await delay(1);
      return [{ key: FIRST, entries: [entry('9-0')] }];
    });

    expect(await collect(first, 1)).toEqual(['9-0']);
    expect(await collect(second, 1)).toEqual(['9-0']);
    // The whole point of the multiplexer: a blocking read per viewer is what
    // exhausts a Redis connection pool, and this is the number that says it does
    // not happen.
    expect(createStreamReader).toHaveBeenCalledTimes(1);
    expect(cursorsAsked().at(-1)?.size).toBe(1);
  });

  it('stays on the reader that already has the stream, even when that one is full', async () => {
    // 64 streams per reader. Once one is full the next stream opens another
    // connection — but a stream already being tailed must not, or the same
    // entries would arrive twice down two different reads.
    const many = Array.from({ length: 64 }, (_unused, index) =>
      K.streamBuffer(
        MessageId.trusted(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
      ),
    );
    // eslint-disable-next-line no-await-in-loop -- filling one reader, in order.
    for (const key of many) await watch(key);
    expect(createStreamReader).toHaveBeenCalledTimes(1);

    await watch(many[0] ?? FIRST);

    expect(createStreamReader).toHaveBeenCalledTimes(1);
  });

  it('asks where the stream is only for the first of them', async () => {
    await watch(FIRST);
    await watch(FIRST);

    // The second must not rewind the shared cursor: the first would then be
    // handed entries it has already seen, and it is the one further along.
    expect(endOfStream).toHaveBeenCalledTimes(1);
  });

  it('keeps tailing for the one that stays', async () => {
    const leaving = await watch(FIRST);
    await watch(FIRST);

    leaving.close();
    await delay(20);

    expect(cursorsAsked().at(-1)?.has(FIRST)).toBe(true);
  });
});

describe('more streams than the readers can hold', () => {
  it('packs them in rather than refusing anyone their own answer', async () => {
    // Eight readers of sixty-four streams each. Past that a reader with more
    // keys than intended is slower, and a person who cannot watch their own
    // answer is broken — so the ceiling bends.
    const many = Array.from({ length: 8 * 64 + 1 }, (_unused, index) =>
      K.streamBuffer(
        MessageId.trusted(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
      ),
    );
    // eslint-disable-next-line no-await-in-loop -- filling the readers, in order.
    for (const key of many) await watch(key);

    expect(createStreamReader).toHaveBeenCalledTimes(8);
    expect(cursorsAsked().at(-1)?.size).toBeGreaterThan(0);
  });
});

describe('a stream nobody is watching any more', () => {
  it('leaves the read, and the reader stops when the last one goes', async () => {
    const subscription = await watch(FIRST);
    await watch(SECOND);
    await delay(20);
    expect(cursorsAsked().at(-1)?.size).toBe(2);

    subscription.close();
    await delay(20);
    expect(cursorsAsked().at(-1)?.get(FIRST)).toBeUndefined();

    for (const each of open) each.close();
    const asked = read.mock.calls.length;
    await delay(30);
    // Nothing left to tail: the loop ends rather than blocking on an empty list
    // for as long as the process lives.
    expect(read.mock.calls.length).toBe(asked);
  });

  it('does not put itself back into the read when the last reader left mid-read', async () => {
    // The blocking read is in flight for most of every second, so a client
    // disconnecting while its answer is streaming lands inside one almost
    // always. What comes back then must not re-track a stream nobody is
    // watching: the reader would tail it for the life of the process and its
    // place in the sixty-four is gone with it.
    read.mockImplementation(async () => {
      await delay(10);
      return [{ key: FIRST, entries: [entry('1-0')] }];
    });
    const subscription = await watch(FIRST);
    await delay(2);

    subscription.close();
    const asked = read.mock.calls.length;
    // Long enough to outlast the pause a failed read takes, so a reader that
    // crashes on every delivery counts as tailing rather than as stopping.
    await delay(300);

    expect(read.mock.calls.length).toBe(asked);
  });

  it('is not left without a tail when someone attaches during the last read', async () => {
    // The narrow window: the loop only notices its list has emptied after the
    // blocking read returns, so an attach in between finds `running` still true
    // and spawns nothing. The loop's own exit is what has to catch it.
    const leaving = await watch(FIRST);
    await delay(1);
    leaving.close();
    await watch(FIRST);

    const asked = read.mock.calls.length;
    await delay(30);

    expect(read.mock.calls.length).toBeGreaterThan(asked);
  });

  it('is tailed again from wherever it has got to when someone comes back', async () => {
    (await watch(FIRST)).close();
    endOfStream.mockResolvedValue('12-0');

    await watch(FIRST);
    await delay(20);

    expect(cursorsAsked().at(-1)?.get(FIRST)).toBe('12-0');
  });
});

describe('a read that fails', () => {
  it('is waited out rather than ending the tail for everyone', async () => {
    read.mockRejectedValueOnce(new Error('redis went away'));

    await watch(FIRST);
    await delay(300);

    // One failure must not take down the tail that every other generation on
    // this pod is being served by.
    expect(read.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('a process that is shutting down', () => {
  it('ends the subscription instead of leaving it waiting for a tail', async () => {
    await tasks.drain(10);

    const subscription = await watch(FIRST);

    // `drain` has already refused new work, so nothing will ever read this
    // stream. Waiting would hold the connection open until the socket was cut.
    expect(await collect(subscription, 1)).toEqual([]);
  });
});
