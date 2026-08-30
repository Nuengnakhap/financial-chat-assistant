import { Inject, Injectable } from '@nestjs/common';

import type { Principal } from '../../../shared/http/request-context';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';
import type { SessionSummary } from '../ports/session.repository';

/**
 * A deliberate ceiling, not an oversight. Nothing caps how often a person may
 * sign in, so the list has to be bounded like every other listing here. What
 * falls off is bounded too: the order is most-recently-used first, so a
 * truncated session is by definition the stalest one, and a sliding TTL counted
 * from last use means it expires on its own. Recovering from a lost password by
 * ending every other session would need an endpoint of its own; the contract
 * does not have one, and adding it is a decision rather than an omission.
 */
const MAX_SESSIONS = 100;

export interface ListedSession extends SessionSummary {
  /** The one the caller is asking from, so a client can label it and refuse to end it silently. */
  readonly current: boolean;
}

@Injectable()
export class ListSessionsUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * Takes the whole principal rather than a user id: which session is "current"
   * is only knowable from the token the request arrived with, and passing the
   * two separately is how they end up out of step.
   */
  async execute(principal: Principal, now = new Date()): Promise<readonly ListedSession[]> {
    const sessions = await this.uow.run(
      async (ctx) =>
        await ctx.sessions.listForOwner({ userId: principal.userId }, MAX_SESSIONS, now),
    );

    return sessions.map((session) => ({
      ...session,
      current: session.id === principal.sessionId,
    }));
  }
}
