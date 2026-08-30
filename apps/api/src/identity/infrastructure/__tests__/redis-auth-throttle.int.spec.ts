import type { AppConfig } from '@fca/config';
import { isErr, isOk, RateLimitedError } from '@fca/domain';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { RedisService } from '../../../shared/redis/redis.service';
import { RedisAuthThrottle, type ThrottleLimits } from '../redis-auth-throttle';

const silent = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));
const EMAIL = 'ada@example.com';
const IP = 'f'.repeat(64);
const OTHER_IP = 'a'.repeat(64);

const OPTIONS: ThrottleLimits = { windowMs: 2_000, perEmail: 3, perIp: 5, registrationsPerIp: 2 };

let redis: RedisService;
let admin: Redis;

function url(): string {
  const value = process.env['TEST_REDIS_URL'];
  if (value === undefined) throw new Error('TEST_REDIS_URL is not set; global setup did not run');
  return value;
}

const throttleWith = (options: ThrottleLimits = OPTIONS): RedisAuthThrottle =>
  new RedisAuthThrottle(redis, options);

beforeAll(() => {
  const config: AppConfig = { ...testConfig(), redis: { url: url() } };
  redis = new RedisService(config, silent);
  admin = new Redis(url());
});
afterEach(async () => {
  await admin.flushall();
});
afterAll(async () => {
  await redis.onModuleDestroy();
  await admin.quit();
});

describe('counting sign-in attempts', () => {
  it('allows the window and refuses the one after it', async () => {
    const throttle = throttleWith();

    for (let attempt = 0; attempt < OPTIONS.perEmail; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- order is the thing under test
      expect(isOk(await throttle.recordSignIn(EMAIL, IP))).toBe(true);
    }

    const refused = await throttle.recordSignIn(EMAIL, IP);

    expect(isErr(refused) && refused.error).toBeInstanceOf(RateLimitedError);
  });

  it('says how long to wait, and never says zero', async () => {
    const throttle = throttleWith();
    await Promise.all([
      throttle.recordSignIn(EMAIL, IP),
      throttle.recordSignIn(EMAIL, IP),
      throttle.recordSignIn(EMAIL, IP),
    ]);

    const refused = await throttle.recordSignIn(EMAIL, IP);

    // `Retry-After: 0` tells a client to come straight back, which is the one
    // answer a rate limiter must never give.
    expect(isErr(refused) && refused.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(isErr(refused) && refused.error.retryAfterSeconds).toBeLessThanOrEqual(2);
  });

  it('counts attempts in the same millisecond separately', async () => {
    const throttle = throttleWith();

    // Fired together on purpose: if the sorted-set member were the timestamp,
    // these would collapse into one and the limit would be worth nothing.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => throttle.recordSignIn(EMAIL, IP)),
    );

    expect(results.filter(isOk)).toHaveLength(OPTIONS.perEmail);
  });

  it('lets the window slide rather than blocking for good', async () => {
    const throttle = throttleWith({ ...OPTIONS, windowMs: 150 });
    await Promise.all([
      throttle.recordSignIn(EMAIL, IP),
      throttle.recordSignIn(EMAIL, IP),
      throttle.recordSignIn(EMAIL, IP),
    ]);
    expect(isErr(await throttle.recordSignIn(EMAIL, IP))).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(isOk(await throttle.recordSignIn(EMAIL, IP))).toBe(true);
  });
});

describe('counting the address and the caller apart', () => {
  it('keeps blocking an address however many hosts it comes from', async () => {
    const throttle = throttleWith();
    await Promise.all([
      throttle.recordSignIn(EMAIL, IP),
      throttle.recordSignIn(EMAIL, IP),
      throttle.recordSignIn(EMAIL, IP),
    ]);

    // One account ground down from a rented fleet is the case the per-email
    // counter exists for.
    expect(isErr(await throttle.recordSignIn(EMAIL, OTHER_IP))).toBe(true);
  });

  it('stops one host walking a list of addresses', async () => {
    const throttle = throttleWith({ ...OPTIONS, perIp: 2 });
    await throttle.recordSignIn('a@example.com', IP);
    await throttle.recordSignIn('b@example.com', IP);

    expect(isErr(await throttle.recordSignIn('c@example.com', IP))).toBe(true);
  });
});

describe('counting registrations', () => {
  it('bounds how fast one host can ask whether an address is taken', async () => {
    const throttle = throttleWith();
    await throttle.recordRegistration(IP);
    await throttle.recordRegistration(IP);

    expect(isErr(await throttle.recordRegistration(IP))).toBe(true);
  });

  it('keeps its own counter, so registering cannot spend the sign-in budget', async () => {
    const throttle = throttleWith();
    await throttle.recordRegistration(IP);
    await throttle.recordRegistration(IP);
    expect(isErr(await throttle.recordRegistration(IP))).toBe(true);

    // Two separate keys: an exhausted registration counter must not turn into
    // a way to keep a host from signing in at all.
    expect(isOk(await throttle.recordSignIn(EMAIL, IP))).toBe(true);
  });

  it('is not reset by signing in', async () => {
    const throttle = throttleWith();
    await throttle.recordRegistration(IP);
    await throttle.recordRegistration(IP);

    await throttle.clearSignIn(EMAIL);

    expect(isErr(await throttle.recordRegistration(IP))).toBe(true);
  });
});

describe('after signing in', () => {
  it('forgets the failures for that address', async () => {
    const throttle = throttleWith();
    await Promise.all([
      throttle.recordSignIn(EMAIL, IP),
      throttle.recordSignIn(EMAIL, IP),
      throttle.recordSignIn(EMAIL, IP),
    ]);

    await throttle.clearSignIn(EMAIL);

    expect(isOk(await throttle.recordSignIn(EMAIL, IP))).toBe(true);
  });

  it('leaves the host counter alone, so a shared address cannot reset it', async () => {
    const throttle = throttleWith({ ...OPTIONS, perEmail: 10, perIp: 2 });
    await throttle.recordSignIn(EMAIL, IP);
    await throttle.recordSignIn(EMAIL, IP);

    await throttle.clearSignIn(EMAIL);

    // Otherwise one account the attacker owns resets the limit for all of them.
    expect(isErr(await throttle.recordSignIn(EMAIL, IP))).toBe(true);
  });
});
