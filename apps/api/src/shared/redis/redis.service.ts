import type { AppConfig } from '@fca/config';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import type { RedisKey } from './keys';
import type { LuaScript } from './lua-script';
import { APP_CONFIG } from '../config/app-config.token';
import type { HealthIndicator } from '../health/health-indicator';
import { AppLogger } from '../observability/app-logger';

/** One retry, then the caller hears about it — a request must not wait out a reconnect loop. */
const MAX_RETRIES_PER_REQUEST = 1;

/**
 * The only place that knows ioredis exists. Every command goes through a method
 * here, so a key never appears as a literal and the client can be replaced
 * without touching a use case.
 */
@Injectable()
export class RedisService implements OnModuleDestroy, HealthIndicator {
  readonly name = 'redis';
  private readonly client: Redis;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: AppLogger,
  ) {
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
