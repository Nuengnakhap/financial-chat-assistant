import type { AppConfig } from '@fca/config';
import { Err, Ok, RateLimitedError, type Result } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { K, type RedisKey } from '../../shared/redis/keys';
import { RedisService } from '../../shared/redis/redis.service';
import { FORGET_WINDOW, recordInWindow } from '../../shared/redis/sliding-window';
import type { AuthThrottle } from '../application/ports/auth-throttle';

export type ThrottleLimits = AppConfig['auth']['throttle'];

export const THROTTLE_LIMITS = Symbol('ThrottleLimits');

@Injectable()
export class RedisAuthThrottle implements AuthThrottle {
  constructor(
    private readonly redis: RedisService,
    @Inject(THROTTLE_LIMITS) private readonly limits: ThrottleLimits,
  ) {}

  async recordSignIn(email: string, ipHash: string): Promise<Result<void, RateLimitedError>> {
    // Independent counters, so they are two calls rather than one script over
    // two keys — which would have to share a slot to survive a cluster.
    const waits = await Promise.all([
      this.record(K.authThrottleEmail(email), this.limits.perEmail),
      this.record(K.authThrottleIp(ipHash), this.limits.perIp),
    ]);

    return this.verdict(Math.max(...waits));
  }

  async recordRegistration(ipHash: string): Promise<Result<void, RateLimitedError>> {
    const wait = await this.record(
      K.registrationThrottleIp(ipHash),
      this.limits.registrationsPerIp,
    );

    return this.verdict(wait);
  }

  async clearSignIn(email: string): Promise<void> {
    await this.redis.runScript(FORGET_WINDOW, [K.authThrottleEmail(email)], []);
  }

  private verdict(waitMs: number): Result<void, RateLimitedError> {
    if (waitMs === 0) return Ok(undefined);

    return Err(
      new RateLimitedError('Too many attempts.', Math.ceil(waitMs / 1_000), { limit: 'auth' }),
    );
  }

  private async record(key: RedisKey, limit: number): Promise<number> {
    return await recordInWindow(this.redis, key, { windowMs: this.limits.windowMs, limit });
  }
}
