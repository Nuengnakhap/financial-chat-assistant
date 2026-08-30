import type { AppConfig } from '@fca/config';
import { Err, Ok, RateLimitedError, type Result } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { K, type RedisKey } from '../../shared/redis/keys';
import { luaScript } from '../../shared/redis/lua-script';
import { RedisService } from '../../shared/redis/redis.service';
import type { AuthThrottle } from '../application/ports/auth-throttle';

/**
 * A sliding window as a sorted set of attempt timestamps. One script because
 * the trim, the count and the insert have to see the same state: run as three
 * commands, two callers both read a count of four and both become the fifth.
 *
 * Returns the milliseconds to wait, or 0 when the attempt was allowed — the
 * wait is what the caller owes `Retry-After`, and only the script knows when
 * the oldest attempt in the window falls out of it.
 */
const RECORD_ATTEMPT = luaScript(
  'auth-throttle',
  `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return math.max(1, math.ceil(tonumber(oldest[2]) + window - now))
end

-- The member has to be unique or two attempts in the same millisecond count once.
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return 0
`,
);

/** The facade only speaks Lua, so forgetting a counter is a one-line script. */
const CLEAR = luaScript('auth-throttle-clear', 'return redis.call("DEL", KEYS[1])');

export type ThrottleLimits = AppConfig['auth']['throttle'];

export const THROTTLE_LIMITS = Symbol('ThrottleLimits');

@Injectable()
export class RedisAuthThrottle implements AuthThrottle {
  constructor(
    private readonly redis: RedisService,
    @Inject(THROTTLE_LIMITS) private readonly limits: ThrottleLimits,
  ) {}

  async recordSignIn(email: string, ipHash: string): Promise<Result<void, RateLimitedError>> {
    const attempt = newAttemptId();
    // Independent counters, so they are two calls rather than one script over
    // two keys — which would have to share a slot to survive a cluster.
    const waits = await Promise.all([
      this.record(K.authThrottleEmail(email), this.limits.perEmail, attempt),
      this.record(K.authThrottleIp(ipHash), this.limits.perIp, attempt),
    ]);

    return this.verdict(Math.max(...waits));
  }

  async recordRegistration(ipHash: string): Promise<Result<void, RateLimitedError>> {
    const wait = await this.record(
      K.registrationThrottleIp(ipHash),
      this.limits.registrationsPerIp,
      newAttemptId(),
    );

    return this.verdict(wait);
  }

  async clearSignIn(email: string): Promise<void> {
    await this.redis.runScript(CLEAR, [K.authThrottleEmail(email)], []);
  }

  private verdict(waitMs: number): Result<void, RateLimitedError> {
    if (waitMs === 0) return Ok(undefined);

    return Err(
      new RateLimitedError('Too many attempts.', Math.ceil(waitMs / 1_000), { limit: 'auth' }),
    );
  }

  private async record(key: RedisKey, limit: number, attempt: string): Promise<number> {
    const wait = await this.redis.runScript(
      RECORD_ATTEMPT,
      [key],
      [Date.now(), this.limits.windowMs, limit, attempt],
    );

    return typeof wait === 'number' ? wait : 0;
  }
}

const newAttemptId = (): string => `${String(Date.now())}:${crypto.randomUUID()}`;
