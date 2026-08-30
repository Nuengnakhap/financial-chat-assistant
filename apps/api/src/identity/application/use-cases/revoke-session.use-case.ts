import { Err, NotFoundError, Ok, SessionId, type Result } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import type { Principal } from '../../../shared/http/request-context';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';

const GONE = 'That session does not exist.';

@Injectable()
export class RevokeSessionUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * Someone else's session answers exactly as a session that never existed
   * does, so nobody can find out which ids are real by asking. Revoking one
   * already revoked answers the same way for the same reason.
   *
   * Ending the caller's own session is allowed: it is what "sign out everywhere"
   * is made of. The access token it was carrying stays valid until it expires,
   * which is the window short-lived tokens are chosen to bound.
   */
  async execute(
    principal: Principal,
    id: string,
    now = new Date(),
  ): Promise<Result<void, NotFoundError>> {
    const parsed = SessionId.parse(id);
    // A malformed id is not a validation failure to report — it is an id that
    // cannot name anything, and saying so would separate "wrong shape" from
    // "not yours".
    if (!parsed.ok) return Err(new NotFoundError(GONE, { reason: 'malformed_id' }));

    const revoked = await this.uow.run(
      async (ctx) => await ctx.sessions.revoke({ userId: principal.userId }, parsed.value, now),
    );

    return revoked ? Ok(undefined) : Err(new NotFoundError(GONE));
  }
}
