import type { AppConfig } from '@fca/config';
import type { StreamEvent } from '@fca/contracts';
import { MessageId } from '@fca/domain';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TaskRegistry } from '../../../bootstrap/task-registry';
import { testConfig } from '../../../shared/config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { K } from '../../../shared/redis/keys';
import { RedisService } from '../../../shared/redis/redis.service';
import { StreamMultiplexer } from '../../../shared/redis/stream-multiplexer';
import { generationEventsContract } from '../../application/ports/__tests__/generation-events.contract';
import {
  STREAM_START,
  type StoredStreamEvent,
} from '../../application/ports/generation-events.port';
import { GenerationStream } from '../generation-stream';

/**
 * The durable stream against a real Redis, because every property it exists for
 * is a property of Redis: that a reader attaching late sees what it missed, that
 * two readers of one generation cost one connection between them, and that
 * resuming from an id and attaching for the first time are the same path.
 */

const silent = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

function redisUrl(): string {
  const url = process.env['TEST_REDIS_URL'];
  if (url === undefined) throw new Error('TEST_REDIS_URL is not set; the global setup did not run');

  return url;
}

const ANSWER = MessageId.trusted('a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d');

const text = (delta: string): StreamEvent => ({ type: 'text_delta', delta });
const failed: StreamEvent = { type: 'error', code: 'generation_failed', message: 'no' };

let redis: RedisService;
let tasks: TaskRegistry;
let streams: StreamMultiplexer;
let stream: GenerationStream;
let admin: Redis;

beforeAll(() => {
  const config: AppConfig = { ...testConfig(), redis: { url: redisUrl() } };
  redis = new RedisService(config, silent);
  tasks = new TaskRegistry(silent);
  streams = new StreamMultiplexer(redis, tasks, silent);
  stream = new GenerationStream(redis, streams);
  admin = new Redis(redisUrl());
});

afterEach(async () => {
  await admin.flushall();
});

afterAll(async () => {
  await streams.onModuleDestroy();
  await redis.onModuleDestroy();
  await admin.quit();
});

/** Reads until the generation ends, the way an SSE connection does. */
async function readAll(afterId = STREAM_START): Promise<readonly StoredStreamEvent[]> {
  const seen: StoredStreamEvent[] = [];
  const controller = new AbortController();

  for await (const stored of stream.read(ANSWER, afterId, controller.signal)) {
    seen.push(stored);
  }

  return seen;
}

const typesOf = (events: readonly StoredStreamEvent[]) =>
  events.map((stored) =>
    stored.event.type === 'text_delta' ? stored.event.delta : stored.event.type,
  );

/**
 * Everything the port promises, asked of the adapter that is actually deployed.
 * The suite is shared with the in-memory implementation next to the port, so a
 * sentence that only holds because of how Redis happens to behave fails there
 * rather than being written into the contract.
 */
generationEventsContract('redis', () => stream);

describe('attaching to a generation that has already finished', () => {
  it('replays all of it and ends, without waiting for anything live', async () => {
    for (const event of [text('Apple'), text(' earned'), failed])
      // eslint-disable-next-line no-await-in-loop -- written in order on purpose.
      await stream.append(ANSWER, event);

    expect(typesOf(await readAll())).toEqual(['Apple', ' earned', 'error']);
  });

  it('gives every event an id a client can come back with', async () => {
    await stream.append(ANSWER, text('one'));
    await stream.append(ANSWER, failed);

    const seen = await readAll();

    // Not synthetic: each of these is a position in the stream, and resuming
    // from one has to mean the same thing to the next request.
    expect(seen.every((stored) => stored.id !== null)).toBe(true);
    expect(typesOf(await readAll(seen[0]?.id ?? STREAM_START))).toEqual(['error']);
  });

  it('stops at the terminal event even when something was written after it', async () => {
    // A janitor and a runner can both decide a generation is over. The second
    // one to write must not appear as more answer arriving.
    await stream.append(ANSWER, failed);
    await stream.append(ANSWER, text('and then'));

    expect(typesOf(await readAll())).toEqual(['error']);
  });
});

describe('attaching while the answer is still being written', () => {
  it('receives what arrives after it attached', async () => {
    const reading = readAll();
    // The write happens after `read` has begun, so nothing about this is a
    // replay: it can only arrive through the live tail.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await stream.append(ANSWER, text('live'));
    await stream.append(ANSWER, failed);

    expect(typesOf(await reading)).toEqual(['live', 'error']);
  });

  it('loses nothing written between the attach and the replay finishing', async () => {
    await stream.append(ANSWER, text('before'));

    const reading = readAll();
    await stream.append(ANSWER, text('during'));
    await stream.append(ANSWER, failed);

    // The overlap between replay and live is what this proves: one of these
    // arrives through each path, and neither is duplicated or dropped.
    expect(typesOf(await reading)).toEqual(['before', 'during', 'error']);
  });

  it('serves two readers of one generation from one connection', async () => {
    const before = await connectionCount();

    const both = Promise.all([readAll(), readAll()]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stream.append(ANSWER, text('shared'));
    await stream.append(ANSWER, failed);
    const [first, second] = await both;

    expect(typesOf(first)).toEqual(['shared', 'error']);
    expect(typesOf(second)).toEqual(['shared', 'error']);
    // One reader loop for both of them. The design this replaced would have
    // taken a blocking connection per person watching.
    expect(await connectionCount()).toBeLessThanOrEqual(before + 1);
  });

  it('resumes from an id without repeating what came before it', async () => {
    await stream.append(ANSWER, text('one'));
    const [first] = await readAllSoFar();

    const reading = readAll(first?.id ?? STREAM_START);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stream.append(ANSWER, text('two'));
    await stream.append(ANSWER, failed);

    expect(typesOf(await reading)).toEqual(['two', 'error']);
  });
});

describe('a stream nobody wrote to', () => {
  it('is kept only as long as a generation could still be watched', async () => {
    await stream.append(ANSWER, text('hello'));

    const ttl = await admin.ttl(K.streamBuffer(ANSWER));

    // Half an hour, refreshed by every event: long enough to come back to,
    // short enough that finished generations do not accumulate in memory.
    expect(ttl).toBeGreaterThan(1_700);
    expect(ttl).toBeLessThanOrEqual(1_800);
  });
});

/** What is in the stream right now, with no live part. */
async function readAllSoFar(): Promise<readonly StoredStreamEvent[]> {
  const entries = await redis.readStreamAfter(K.streamBuffer(ANSWER), STREAM_START, 100);

  return entries.map((entry) => ({ id: entry.id, event: text('') }));
}

async function connectionCount(): Promise<number> {
  const info = await admin.info('clients');
  const match = /connected_clients:(\d+)/.exec(info);

  return Number(match?.[1] ?? 0);
}
