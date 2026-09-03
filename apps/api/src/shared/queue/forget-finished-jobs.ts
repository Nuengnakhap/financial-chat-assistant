import type { AppConfig } from '@fca/config';
import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../config/app-config.token';
import { OutboxRelay } from '../persistence/outbox-relay';

/** Enough to catch up over a day of sweeps without one of them holding a long lock. */
const MAX_PER_SWEEP = 10_000;

/**
 * How long ago a job has to have been done before it is forgotten, and the one
 * place that reads it. The janitor beside this file decides *when* to ask; this
 * decides *what* the answer means, which is the same split the session janitor
 * and its use case already have.
 */
@Injectable()
export class ForgetFinishedJobs {
  private readonly retentionDays: number;

  constructor(
    private readonly relay: OutboxRelay,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.retentionDays = config.outboxJobRetentionDays;
  }

  async execute(): Promise<number> {
    const before = new Date(Date.now() - this.retentionDays * 86_400_000);

    return await this.relay.forgetFinishedJobs(before, MAX_PER_SWEEP);
  }
}
