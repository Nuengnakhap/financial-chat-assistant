import type { AppConfig } from '@fca/config';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import type { RedisKey } from './keys';
import type { LuaScript } from './lua-script';
import {
  STREAM_FIELD,
  createChannelSubscriber,
  createStreamReader,
  toEntries,
} from './redis-connections';
import type {
  ChannelSubscriber,
  StreamEntry,
  StreamReader,
  StreamRetention,
} from './stream-reader';
import { APP_CONFIG } from '../config/app-config.token';
import type { HealthIndicator } from '../health/health-indicator';
import { AppLogger } from '../observability/app-logger';

/** One retry, then the caller hears about it — a request must not wait out a reconnect loop. */
const MAX_RETRIES_PER_REQUEST = 1;

/**
 * The way into Redis. Every command goes through a method here, so a key never
 * appears as a literal and the client can be replaced without touching a use
 * case; ioredis itself is known only to this file and `redis-connections.ts`,
 * which holds the two clients that cannot be this one.
 */
@Injectable()
export class RedisService implements OnModuleDestroy, HealthIndicator {
  readonly name = 'redis';
  private readonly client: Redis;
  private readonly url: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: AppLogger,
  ) {
    this.url = config.redis.url;
    // lazyConnect so an unreachable Redis makes the app report not-ready rather
    // than fail to boot — a process that cannot start cannot say why.
    this.client = new Redis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    });

    // ioredis treats an unhandled 'error' as fatal, and a reconnect loop emits
    // one per attempt; readiness is the signal for this, not the log.
    this.client.on('error', (error: Error) => {
      this.logger.debug('redis connection error', { scope: 'RedisService', err: error });
    });
  }

  /**
   * EVALSHA first because sending the source on every call wastes the bandwidth
   * the script cache exists to save. The fallback is also how a script gets
   * there in the first place: nothing loads scripts at boot, so the first call
   * after a start — or after a Redis restart — misses and loads it.
   */
  async runScript(
    script: LuaScript,
    keys: readonly RedisKey[],
    args: readonly (string | number)[],
  ): Promise<unknown> {
    try {
      return await this.client.evalsha(script.sha, keys.length, ...keys, ...args);
    } catch (error) {
      if (!isNoScriptError(error)) throw error;
      return await this.client.eval(script.source, keys.length, ...keys, ...args);
    }
  }

  /**
   * `null` for a key that is not there and for one holding something that is not
   * JSON, because a caller can do nothing different about the two: both mean the
   * value has to be produced again. The result is `unknown` on purpose — whoever
   * asked for it knows what shape it should be, and Redis is a boundary where
   * that has to be checked rather than assumed.
   */
  async readJson(key: RedisKey): Promise<unknown> {
    const stored = await this.client.get(key);
    if (stored === null) return null;

    try {
      return JSON.parse(stored);
    } catch {
      return null;
    }
  }

  async writeJson(key: RedisKey, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  /**
   * One round trip for both, because this runs once per token: a stream that
   * outlived its window is worse than one trimmed a little early, and a second
   * call to set the expiry would double the cost of every delta.
   *
   * `MAXLEN ~` is approximate on purpose — exact trimming makes Redis walk the
   * radix tree on every write, and the bound here is about memory rather than
   * about a precise count.
   */
  async appendToStream(
    key: RedisKey,
    payload: string,
    retention: StreamRetention,
  ): Promise<string> {
    const results = await this.client
      .pipeline()
      .xadd(key, 'MAXLEN', '~', retention.maxLength, '*', STREAM_FIELD, payload)
      .expire(key, retention.ttlSeconds)
      .exec();

    const id: unknown = results?.[0]?.[1];
    if (typeof id !== 'string') throw new Error('redis did not answer XADD with an id');

    return id;
  }

  /** Everything after `afterId`, oldest first. Never blocks, so it costs no connection. */
  async readStreamAfter(
    key: RedisKey,
    afterId: string,
    count: number,
  ): Promise<readonly StreamEntry[]> {
    const rows: unknown = await this.client.xrange(key, `(${afterId}`, '+', 'COUNT', count);

    return Array.isArray(rows) ? toEntries(rows) : [];
  }

  /** The id of the last thing written, or `0-0` for a stream nothing has written to. */
  async endOfStream(key: RedisKey): Promise<string> {
    const rows: unknown = await this.client.xrevrange(key, '+', '-', 'COUNT', 1);
    const [last] = Array.isArray(rows) ? toEntries(rows) : [];

    return last?.id ?? '0-0';
  }

  /** Fire and forget by design: nobody listening means nobody to tell. */
  async publish(channel: RedisKey, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  createStreamReader(): StreamReader {
    return createStreamReader(this.url, (error) => {
      this.logger.debug('redis stream reader error', { scope: 'RedisService', err: error });
    });
  }

  createChannelSubscriber(): ChannelSubscriber {
    return createChannelSubscriber(this.url, (error) => {
      this.logger.debug('redis subscriber error', { scope: 'RedisService', err: error });
    });
  }

  async check(): Promise<void> {
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    // quit() drains in-flight replies, but it is a command: a client that never
    // connected would have to connect in order to send it.
    if (this.client.status === 'wait' || this.client.status === 'end') {
      this.client.disconnect();
      return;
    }
    await this.client.quit();
  }
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOSCRIPT');
}
