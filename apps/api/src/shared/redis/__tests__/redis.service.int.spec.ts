import type { AppConfig } from '@fca/config';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { testConfig } from '../../config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import { K } from '../keys';
import { luaScript } from '../lua-script';
import { RedisService } from '../redis.service';

const COUNTER = luaScript('counter', 'return redis.call("INCRBY", KEYS[1], ARGV[1])');

const silentLogger = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

function redisUrl(): string {
  const url = process.env['TEST_REDIS_URL'];
  if (url === undefined) throw new Error('TEST_REDIS_URL is not set; the global setup did not run');
  return url;
}

function serviceFor(url: string): RedisService {
  const config: AppConfig = { ...testConfig(), redis: { url } };
  return new RedisService(config, silentLogger);
}

let service: RedisService;
let admin: Redis;

beforeAll(() => {
  service = serviceFor(redisUrl());
  admin = new Redis(redisUrl());
});

afterEach(async () => {
  await admin.flushall();
});

afterAll(async () => {
  await service.onModuleDestroy();
  await admin.quit();
});

describe('running a Lua script', () => {
  it('applies it atomically and returns what the script returned', async () => {
    const key = K.queryCache('counter-test');

    expect(await service.runScript(COUNTER, [key], [5])).toBe(5);
    expect(await service.runScript(COUNTER, [key], [3])).toBe(8);
  });

  it('caches the script under the digest computed locally', async () => {
    await service.runScript(COUNTER, [K.queryCache('a')], [1]);

    // If these differed, EVALSHA would miss on every call and the cache would
    // be doing nothing while appearing to work.
    expect(await admin.script('EXISTS', COUNTER.sha)).toEqual([1]);
  });

  it('reloads the script after Redis has forgotten it', async () => {
    const key = K.queryCache('survives-flush');
    await service.runScript(COUNTER, [key], [2]);

    // What a Redis restart looks like from the client's side.
    await admin.script('FLUSH');

    expect(await service.runScript(COUNTER, [key], [4])).toBe(6);
    expect(await admin.script('EXISTS', COUNTER.sha)).toEqual([1]);
  });

  it('reports an error from the script rather than retrying it as a cache miss', async () => {
    const broken = luaScript('broken', 'return redis.call("INCRBY", KEYS[1], "not-a-number")');
    const key = K.queryCache('broken');

    // The first call loads the script, so it fails inside EVAL. The second one
    // fails inside EVALSHA, which is where a NOSCRIPT check that only looked at
    // "did it fail" would loop back and send the source again forever.
    await expect(service.runScript(broken, [key], [])).rejects.toThrow(/not an integer/i);
    await expect(service.runScript(broken, [key], [])).rejects.toThrow(/not an integer/i);
  });
});

describe('readiness', () => {
  it('passes while the server answers', async () => {
    await expect(service.check()).resolves.toBeUndefined();
  });

  it('fails rather than hangs when the server is unreachable', async () => {
    // Port 1 has nothing on it; the client must surface that, not wait it out.
    const unreachable = serviceFor('redis://127.0.0.1:1');

    await expect(unreachable.check()).rejects.toThrow();
    await unreachable.onModuleDestroy();
  });
});

describe('closing', () => {
  it('releases a client that was never connected', async () => {
    const unused = serviceFor(redisUrl());

    await expect(unused.onModuleDestroy()).resolves.toBeUndefined();
  });
});
