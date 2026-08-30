import type { AppConfig } from '@fca/config';
import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../../../shared/config/app-config.token';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';

const MS_PER_DAY = 86_400_000;

@Injectable()
export class PurgeDeadSessionsUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Nothing else ever deletes a session or a token, and both tables grow with
   * every sign-in and every refresh. The retention window is what keeps a
   * revoked device visible long enough to be looked at afterwards.
   */
  async execute(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.config.auth.sessionRetentionDays * MS_PER_DAY);

    return await this.uow.run(async (ctx) => await ctx.sessions.deleteDeadBefore(cutoff));
  }
}
