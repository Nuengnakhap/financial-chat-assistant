import { authContract, type Ok } from '@fca/contracts';
import { UnauthenticatedError } from '@fca/domain';
import { Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { REFRESH_COOKIE, SessionCookies } from './session-cookies';
import { requirePrincipal } from '../../shared/http/request-context';
import { SessionGuard } from '../../shared/http/session.guard';
import { RotateRefreshTokenUseCase } from '../application/use-cases/rotate-refresh-token.use-case';
import { SignOutUseCase } from '../application/use-cases/sign-out.use-case';

const OK: Ok = { ok: true };

/** What happens to a session that already exists: it is renewed, or it ends. */
@Controller()
export class SessionController {
  constructor(
    private readonly cookies: SessionCookies,
    private readonly rotate: RotateRefreshTokenUseCase,
    private readonly signOut: SignOutUseCase,
  ) {}

  /**
   * Not behind `SessionGuard`: the access token has usually expired by the time
   * a client gets here, which is the whole reason it is asking.
   */
  @Post('api/v1/auth/refresh')
  // Nest answers 201 to a POST by default; the contract says 200 and it wins.
  @HttpCode(authContract.refresh.status)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Ok> {
    const presented = request.cookies[REFRESH_COOKIE];
    if (presented === undefined) {
      this.cookies.clear(reply);
      throw new UnauthenticatedError('No refresh token was presented.');
    }

    const result = await this.rotate.execute(presented);
    if (!result.ok) {
      // A token we have refused is one the browser should stop sending,
      // whichever of the four reasons it was refused for.
      this.cookies.clear(reply);
      throw result.error;
    }

    this.cookies.set(reply, result.value);
    return OK;
  }

  @Post('api/v1/auth/logout')
  @HttpCode(authContract.logout.status)
  @UseGuards(SessionGuard)
  async logout(@Res({ passthrough: true }) reply: FastifyReply): Promise<Ok> {
    const principal = requirePrincipal();

    await this.signOut.execute(principal.userId, principal.sessionId);
    this.cookies.clear(reply);

    return OK;
  }
}
