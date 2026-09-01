import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import { K } from '../../redis/keys';
import type { RedisService } from '../../redis/redis.service';
import { LayeredCache, type CacheSlot } from '../layered-cache';

/**
 * What a fake can prove here is what the cache does with what Redis says, and
 * that is the whole of the behaviour: the tiers, the flight, and what happens
 * when the shared tier is unusable. The real server is exercised where it can
 * fail differently — a script it has forgotten, a key it has expired — which is
 * the integration suite's job.
 */

const shape = z.object({ rows: z.array(z.string()) });
type Shape = z.infer<typeof shape>;

const slot: CacheSlot<Shape> = { key: K.queryCache('abc'), ttlSeconds: 60, schema: shape };

interface FakeRedis {
  readonly service: RedisService;
  store: Map<string, unknown>;
  reads: number;
  writes: number;
  failReads: boolean;
  failWrites: boolean;
}

function fakeRedis(): FakeRedis {
  const fake: FakeRedis = {
    store: new Map(),
    reads: 0,
    writes: 0,
    failReads: false,
    failWrites: false,
    service: {
      readJson: async (key: string): Promise<unknown> => {
        fake.reads += 1;
        if (fake.failReads) throw new Error('redis is down');
        return await Promise.resolve(fake.store.get(key) ?? null);
      },
      writeJson: async (key: string, value: unknown): Promise<void> => {
        fake.writes += 1;
        if (fake.failWrites) throw new Error('redis is down');
        fake.store.set(key, await Promise.resolve(value));
      },
    } as unknown as RedisService,
  };

  return fake;
}

function silentLogger(): AppLogger {
  return new AppLogger(
    createPinoLogger({ level: 'silent', pretty: false, destination: process.stdout }),
  );
}

let redis: FakeRedis;
let cache: LayeredCache;

beforeEach(() => {
  redis = fakeRedis();
  cache = new LayeredCache(redis.service, silentLogger());
});

describe('the layered cache', () => {
  it('asks the source once, then answers from memory', async () => {
    const load = vi.fn(async () => await Promise.resolve({ rows: ['a'] }));

    expect(await cache.get(slot, load)).toEqual({ rows: ['a'] });
    expect(await cache.get(slot, load)).toEqual({ rows: ['a'] });

    expect(load).toHaveBeenCalledTimes(1);
    // The second answer came from memory, so Redis was not asked again either.
    expect(redis.reads).toBe(1);
  });

  it('answers a cold process from the shared tier', async () => {
    redis.store.set(slot.key, { rows: ['from redis'] });
    const load = vi.fn(async () => await Promise.resolve({ rows: ['from source'] }));

    expect(await cache.get(slot, load)).toEqual({ rows: ['from redis'] });
    expect(load).not.toHaveBeenCalled();
  });

  it('gives concurrent callers one call to the source', async () => {
    // The stampede: ten requests arrive in the same moment a key is missing.
    let started = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = async (): Promise<Shape> => {
      started += 1;
      await held;
      return { rows: ['once'] };
    };

    const flights = Array.from({ length: 10 }, async () => await cache.get(slot, load));
    release();

    expect(await Promise.all(flights)).toEqual(
      Array.from({ length: 10 }, () => ({ rows: ['once'] })),
    );
    expect(started).toBe(1);
    expect(redis.writes).toBe(1);
  });

  it('lets the next caller try again after the source fails', async () => {
    const failing = vi.fn(async () => await Promise.reject(new Error('no database')));

    await expect(cache.get(slot, failing)).rejects.toThrow('no database');

    // A flight that failed must not be left in the map: every later caller for
    // that key would await a rejected promise for as long as the process lived.
    const load = vi.fn(async () => await Promise.resolve({ rows: ['second try'] }));
    expect(await cache.get(slot, load)).toEqual({ rows: ['second try'] });
  });

  it('serves the request when the shared tier cannot be read', async () => {
    redis.failReads = true;
    const load = vi.fn(async () => await Promise.resolve({ rows: ['still works'] }));

    expect(await cache.get(slot, load)).toEqual({ rows: ['still works'] });
  });

  it('serves the request when the shared tier cannot be written', async () => {
    redis.failWrites = true;
    const load = vi.fn(async () => await Promise.resolve({ rows: ['still works'] }));

    expect(await cache.get(slot, load)).toEqual({ rows: ['still works'] });
  });

  it('treats a cached value of the wrong shape as absent', async () => {
    // What a deploy looks like from here: the key holds what the last version wrote.
    redis.store.set(slot.key, { rows: 'not an array' });
    const load = vi.fn(async () => await Promise.resolve({ rows: ['fresh'] }));

    expect(await cache.get(slot, load)).toEqual({ rows: ['fresh'] });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('answers with the shape the caller asked for, or not at all', async () => {
    // The same key, read back by a slot expecting something else — which is what
    // a changed shape looks like from inside one process rather than across two.
    const other = z.object({ total: z.number() });
    await cache.get(slot, async () => await Promise.resolve({ rows: ['a'] }));

    const load = vi.fn(async () => await Promise.resolve({ total: 1 }));
    expect(await cache.get({ key: slot.key, ttlSeconds: 60, schema: other }, load)).toEqual({
      total: 1,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets an entry once its time is up', async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(async () => await Promise.resolve({ rows: ['a'] }));
      await cache.get(slot, load);

      vi.advanceTimersByTime(slot.ttlSeconds * 1_000 + 1);
      redis.store.clear();
      await cache.get(slot, load);

      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets go of a local copy long before the shared one expires', async () => {
    // The local tier is there to absorb the same query repeated inside one
    // answer, which happens in seconds. Holding it for the slot's whole hour
    // would let one process serve rows that expired everywhere else — after a
    // reseed, for up to another hour.
    vi.useFakeTimers();
    try {
      const hour = { key: K.queryCache('long-lived'), ttlSeconds: 3_600, schema: shape };
      await cache.get(hour, async () => await Promise.resolve({ rows: ['first'] }));

      vi.advanceTimersByTime(61_000);
      redis.store.set(hour.key, { rows: ['reseeded'] });

      const load = vi.fn(async () => await Promise.resolve({ rows: ['from the source'] }));
      expect(await cache.get(hour, load)).toEqual({ rows: ['reseeded'] });
      // The shared copy is what answered, so the source was never asked.
      expect(load).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the newest entries and loses the oldest', async () => {
    // 129 distinct keys against a 128-entry local tier: the first one written is
    // the one that goes, and Redis is what stops that being a source call.
    const slotFor = (index: number): CacheSlot<Shape> => ({
      key: K.queryCache(`key-${String(index)}`),
      ttlSeconds: 60,
      schema: shape,
    });

    for (let index = 0; index < 129; index += 1) {
      // One at a time on purpose: what is being tested is the order they were
      // written in, and a parallel fill has no order to speak of.
      // eslint-disable-next-line no-await-in-loop -- see above
      await cache.get(slotFor(index), async () => await Promise.resolve({ rows: [String(index)] }));
    }

    // Which tier answered has to be observable, or the test cannot tell a hit
    // from an eviction: both would return the same value. So the shared tier is
    // changed underneath, and whose answer comes back says which one was asked.
    for (const index of [0, 128]) {
      redis.store.set(slotFor(index).key, { rows: ['from the shared tier'] });
    }
    const load = vi.fn(async () => await Promise.resolve({ rows: ['from the source'] }));

    // The newest entry is still in memory, so the change is invisible to it.
    expect(await cache.get(slotFor(128), load)).toEqual({ rows: ['128'] });
    // The oldest has been evicted, so it sees the change.
    expect(await cache.get(slotFor(0), load)).toEqual({ rows: ['from the shared tier'] });
    expect(load).not.toHaveBeenCalled();
  });
});
