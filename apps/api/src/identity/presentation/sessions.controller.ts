import { authContract, type Ok, type SessionView } from '@fca/contracts';
import { Controller, Delete, Get, HttpCode, Param, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { SessionCookies } from './session-cookies';
import { requirePrincipal } from '../../shared/http/request-context';
import { SessionGuard } from '../../shared/http/session.guard';
import type { ListedSession } from '../application/use-cases/list-sessions.use-case';
import { ListSessionsUseCase } from '../application/use-cases/list-sessions.use-case';
import { RevokeSessionUseCase } from '../application/use-cases/revoke-session.use-case';

const OK: Ok = { ok: true };

/** Where a person sees the devices they are signed in on, and ends one. */
@Controller()
@UseGuards(SessionGuard)
export class SessionsController {
  constructor(
    private readonly cookies: SessionCookies,
    private readonly list: ListSessionsUseCase,
    private readonly revoke: RevokeSessionUseCase,
  ) {}

  @Get('api/v1/auth/sessions')
  async listSessions(): Promise<{ sessions: SessionView[] }> {
    const sessions = await this.list.execute(requirePrincipal());

    return { sessions: sessions.map(toSessionView) };
  }

  @Delete('api/v1/auth/sessions/:id')
  @HttpCode(authContract.revokeSession.status)
  async revokeSession(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Ok> {
    const principal = requirePrincipal();
    const result = await this.revoke.execute(principal, id);
    // A 404, whether the id is someone else's, malformed, or already revoked.
    if (!result.ok) throw result.error;

    // Ending the session this request arrived on is signing out, and ends the
    // same way. Leaving the cookies would have the browser keep presenting
    // credentials for a session that no longer exists until they expire.
    if (id.toLowerCase() === principal.sessionId) this.cookies.clear(reply);

    return OK;
  }
}

function toSessionView(session: ListedSession): SessionView {
  return {
    id: session.id,
    device: session.device,
    ipHash: session.ipHash,
    lastUsedAt: session.lastUsedAt.toISOString(),
    current: session.current,
  };
}
