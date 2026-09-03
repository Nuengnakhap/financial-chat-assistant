import type { AppConfig } from '@fca/config';
import { Err, Ok, RateLimitedError, type Result, type UserId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../../shared/config/app-config.token';
import { Counters } from '../../shared/observability/counters';
import { K } from '../../shared/redis/keys';
import { RedisService } from '../../shared/redis/redis.service';
import { recordInWindow } from '../../shared/redis/sliding-window';
import type { SendThrottle } from '../application/ports/send-throttle.port';

/** A minute, because the limit is written as questions per minute and read the same way. */
const WINDOW_MS = 60_000;

@Injectable()
export class RedisSendThrottle implements SendThrottle {
  private readonly limit: number;

  constructor(
    private readonly redis: RedisService,
    private readonly counters: Counters,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.limit = config.usage.sendsPerMinute;
  }

  async recordSend(userId: UserId): Promise<Result<void, RateLimitedError>> {
    const wait = await recordInWindow(this.redis, K.sendThrottle(userId), {
      windowMs: WINDOW_MS,
      limit: this.limit,
    });
    if (wait === 0) return Ok(undefined);

    this.counters.count('send.throttled');

    return Err(
      new RateLimitedError(
        'Too many questions in a row. Give the last one a moment.',
        Math.ceil(wait / 1_000),
        { limit: 'sends' },
      ),
    );
  }
}
