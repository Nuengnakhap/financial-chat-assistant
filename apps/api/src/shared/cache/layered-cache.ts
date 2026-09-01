import { Injectable } from '@nestjs/common';
import type { ZodType } from 'zod';

import { AppLogger, asError } from '../observability/app-logger';
import type { RedisKey } from '../redis/keys';
import { RedisService } from '../redis/redis.service';

/**
 * Two tiers and one flight.
 *
 * The tiers are the ordinary part: an in-process map answers in nanoseconds, a
 * Redis key answers in milliseconds and survives a restart, and the source is
 * whatever actually costs something. The flight is the part that matters under
 * load — when a popular key expires, every request in that moment misses it at
 * once, and a cache that has no answer to that is a cache that turns a spike
 * into a stampede. Concurrent callers asking for the same key share one call to
 * the source, which is one line of code and the whole point.
 *
 * A cache is an optimisation and behaves like one: if Redis is unreachable, or
 * holds something that no longer parses, the value is produced again and the
 * request is served. Nothing here can fail a query that would otherwise work.
 */

/** Entries are small — fifty rows at most — and there are not many distinct queries. */
const MAX_LOCAL_ENTRIES = 128;

/**
 * The local tier expires far sooner than the slot asks for, and deliberately:
 * its job is to absorb the same query repeated inside one answer, which happens
 * within seconds. Held for the full time instead, an entry read from Redis late
 * in that key's life would outlive the shared copy by up to another whole TTL —
 * so after a reseed one process could keep serving rows that no longer exist
 * anywhere else. A minute bounds that to a minute.
 */
const MAX_LOCAL_SECONDS = 60;

export interface CacheSlot<T> {
  readonly key: RedisKey;
  readonly ttlSeconds: number;
  /**
   * What a value from Redis has to look like. Another process — or the same one
   * before a deploy — may have written a shape this version no longer reads, and
   * that is a miss rather than a crash.
   */
  readonly schema: ZodType<T>;
}

interface LocalEntry {
  readonly value: unknown;
  readonly expiresAtMs: number;
}

@Injectable()
export class LayeredCache {
  /** Insertion-ordered, which is what makes the oldest key the first one out. */
  private readonly local = new Map<string, LocalEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: RedisService,
    private readonly logger: AppLogger,
  ) {}

  async get<T>(slot: CacheSlot<T>, load: () => Promise<T>): Promise<T> {
    const cached = this.readLocal(slot);
    if (cached !== null) return cached.value;

    const existing = this.inFlight.get(slot.key);
    if (existing !== undefined) {
      // Someone is already doing exactly this. The shape is checked again on the
      // way out because the promise is shared and its type is not.
      return slot.schema.parse(await existing);
    }

    const flight = this.fill(slot, load);
    this.inFlight.set(slot.key, flight);
    try {
      return await flight;
    } finally {
      this.inFlight.delete(slot.key);
    }
  }

  /** Reading a slot's own type back out, or `null` for a miss. */
  private readLocal<T>(slot: CacheSlot<T>): { readonly value: T } | null {
    const entry = this.local.get(slot.key);
    if (entry === undefined) return null;

    if (entry.expiresAtMs <= Date.now()) {
      this.local.delete(slot.key);
      return null;
    }

    const parsed = slot.schema.safeParse(entry.value);
    return parsed.success ? { value: parsed.data } : null;
  }

  private async fill<T>(slot: CacheSlot<T>, load: () => Promise<T>): Promise<T> {
    const shared = await this.readShared(slot);
    if (shared !== null) {
      this.writeLocal(slot, shared.value);
      return shared.value;
    }

    const value = await load();
    this.writeLocal(slot, value);
    await this.writeShared(slot, value);
    return value;
  }

  private async readShared<T>(slot: CacheSlot<T>): Promise<{ readonly value: T } | null> {
    try {
      const stored = await this.redis.readJson(slot.key);
      if (stored === null) return null;

      const parsed = slot.schema.safeParse(stored);
      return parsed.success ? { value: parsed.data } : null;
    } catch (error) {
      this.logger.debug('cache read failed', { scope: 'LayeredCache', err: asError(error) });
      return null;
    }
  }

  private async writeShared<T>(slot: CacheSlot<T>, value: T): Promise<void> {
    try {
      await this.redis.writeJson(slot.key, value, slot.ttlSeconds);
    } catch (error) {
      this.logger.debug('cache write failed', { scope: 'LayeredCache', err: asError(error) });
    }
  }

  private writeLocal<T>(slot: CacheSlot<T>, value: T): void {
    const seconds = Math.min(slot.ttlSeconds, MAX_LOCAL_SECONDS);
    this.local.set(slot.key, { value, expiresAtMs: Date.now() + seconds * 1_000 });

    // The first key in insertion order is the oldest one written, which is the
    // one to lose. Re-reading a key does not make it newer here, deliberately:
    // a cheap approximation, and every entry expires on its own anyway.
    if (this.local.size > MAX_LOCAL_ENTRIES) {
      for (const oldest of this.local.keys()) {
        this.local.delete(oldest);
        break;
      }
    }
  }
}
