import { Err, Ok, UnauthenticatedError, assertNever, type Result } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { AppLogger } from '../../../shared/observability/app-logger';
import {
  UNIT_OF_WORK,
  type TxContext,
  type UnitOfWork,
} from '../../../shared/persistence/unit-of-work';
import { SessionIssuer, type IssuedSession, type RenewalOutcome } from '../session-issuer';

/** Nothing here says which of the four reasons it was; a client cannot act on the difference. */
const EXPIRED = 'Session expired. Please sign in again.';

@Injectable()
export class RotateRefreshTokenUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly issuer: SessionIssuer,
    private readonly logger: AppLogger,
  ) {}

  /**
   * The swap, the revocation it may trigger and the event announcing it all
   * commit together. Cutting a lineage and failing to record why would sign
   * every device out with nothing left saying what happened.
   */
  async execute(presented: string): Promise<Result<IssuedSession, UnauthenticatedError>> {
    return await this.uow.run(async (ctx) => {
      const outcome = await this.issuer.renew(ctx.sessions, presented);
      return await this.resolve(ctx, outcome);
    });
  }

  private async resolve(
    ctx: TxContext,
    outcome: RenewalOutcome,
  ): Promise<Result<IssuedSession, UnauthenticatedError>> {
    switch (outcome.kind) {
      case 'renewed':
        return Ok(outcome.session);

      case 'reused':
        // The real owner and whoever copied the token are indistinguishable from
        // here, so both are signed out and told to start again.
        await ctx.sessions.revokeFamily(outcome.familyId, new Date());
        ctx.publish({
          aggregate: 'session',
          aggregateId: outcome.sessionId,
          type: 'session.token_reuse_detected',
          payload: { familyId: outcome.familyId },
        });
        return Err(new UnauthenticatedError(EXPIRED));

      case 'raced':
        // Two tabs refreshed together. The lineage survives; only this request
        // loses, and the tab that won already holds the cookie replacing it.
        this.logger.debug('refresh lost a race with a concurrent one', {
          scope: 'RotateRefreshTokenUseCase',
        });
        return Err(new UnauthenticatedError(EXPIRED));

      case 'unknown':
        return Err(new UnauthenticatedError(EXPIRED));

      default:
        return assertNever(outcome, 'RenewalOutcome');
    }
  }
}
