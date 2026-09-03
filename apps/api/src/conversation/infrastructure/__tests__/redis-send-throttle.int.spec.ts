import type { AppConfig } from '@fca/config';
import { UserId } from '@fca/domain';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { Counters } from '../../../shared/observability/counters';
import { RedisService } from '../../../shared/redis/redis.service';
import { RedisSendThrottle } from '../redis-send-throttle';

/**
 * The burst limit against a real Redis, because the property it exists for is a
 * property of the script: the trim, the count and the insert see one state, so
 * a burst arriving together cannot all read the same count and all pass.
 *
 * A double running in one thread has already lost the interleaving that would
 * break it, which is the same reason the budget's own script is proven here
 * rather than beside a fake.
 */

const silent = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

function url(): string {
  const value = process.env['TEST_REDIS_URL'];
  if (value === undefined) throw new Error('TEST_REDIS_URL is not set; global setup did not run');

  return value;
}

let redis: RedisService;
let admin: Redis;

const somebodyNew = (): UserId => UserId.trusted(crypto.randomUUID());

function throttleAllowing(sendsPerMinute: number): RedisSendThrottle {
  const config: AppConfig = {
    ...testConfig(),
    redis: { url: url() },
    usage: { ...testConfig().usage, sendsPerMinute },
  };

  return new RedisSendThrottle(redis, new Counters(), config);
}

beforeAll(() => {
  const config: AppConfig = { ...testConfig(), redis: { url: url() } };
  redis = new RedisService(config, silent);
  admin = new Redis(url());
});

beforeEach(async () => {
  await admin.flushall();
});

afterAll(async () => {
  await redis.onModuleDestroy();
  await admin.quit();
});

describe('asking too often', () => {
  it('allows the questions a person reading answers could actually produce', async () => {
    const throttle = throttleAllowing(6);
    const ada = somebodyNew();

    // One after another rather than at once: each has to be counted before the
    // next is asked, which is the shape of somebody reading and then typing.
    for (const _ of Array.from({ length: 6 })) {
      // eslint-disable-next-line no-await-in-loop -- one at a time is what a window counts
      expect((await throttle.recordSend(ada)).ok).toBe(true);
    }
  });

  it('refuses the one after that, and says how long to wait', async () => {
    const throttle = throttleAllowing(2);
    const ada = somebodyNew();
    await throttle.recordSend(ada);
    await throttle.recordSend(ada);

    const third = await throttle.recordSend(ada);

    expect(third.ok).toBe(false);
    if (third.ok) throw new Error('unreachable: the third send was allowed');
    expect(third.error.code).toBe('rate_limited');
    // Whole seconds and never negative, so `Retry-After` can carry it.
    expect(third.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(third.error.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('counts one person against their own limit and nobody else’s', async () => {
    const throttle = throttleAllowing(1);
    const ada = somebodyNew();
    const grace = somebodyNew();
    await throttle.recordSend(ada);

    await expect(throttle.recordSend(ada)).resolves.toMatchObject({ ok: false });
    await expect(throttle.recordSend(grace)).resolves.toMatchObject({ ok: true });
  });

  it('lets no more than the limit through when they all arrive at once', async () => {
    // The property the script exists for. Asking first and counting afterwards
    // lets every one of these read the same count and pass, which is exactly
    // the shape of a burst.
    const throttle = throttleAllowing(3);
    const ada = somebodyNew();

    const verdicts = await Promise.all(
      Array.from({ length: 20 }, async () => await throttle.recordSend(ada)),
    );

    expect(verdicts.filter((verdict) => verdict.ok)).toHaveLength(3);
  });

  it('does not refuse for ever — the window slides', async () => {
    // A window of one minute cannot be waited out in a test, so the limit is
    // read back from Redis instead: the entries expire with the key, and the
    // key carries the window as its TTL.
    const throttle = throttleAllowing(1);
    const ada = somebodyNew();
    await throttle.recordSend(ada);

    const ttl = await admin.pttl(`thr:send:{${ada}}`);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});
