import { Ok, type Result, type SessionId, type UserId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';

@Injectable()
export class SignOutUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * Succeeds whether or not anything was revoked. Signing out of a session that
   * has already gone is the outcome the caller wanted, and reporting it as a
   * failure would leave a client stuck holding a cookie it cannot clear.
   *
   * The live refresh token is left as it is: `rotate` refuses it because the
   * session is revoked, so superseding it would record an event that never
   * happened.
   */
  async execute(userId: UserId, sessionId: SessionId): Promise<Result<void, never>> {
    await this.uow.run(async (ctx) => await ctx.sessions.revoke({ userId }, sessionId, new Date()));

    return Ok(undefined);
  }
}
