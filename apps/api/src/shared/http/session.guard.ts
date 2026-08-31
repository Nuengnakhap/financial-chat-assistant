import { SESSION_COOKIE } from '@fca/contracts';
import { UnauthenticatedError } from '@fca/domain';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { setPrincipal, type Principal } from './request-context';

/**
 * The whole of what a guard needs, which is less than what identity offers.
 * Declared here rather than reached for over there: this is the layer that
 * needs the capability, and naming it here is what keeps `shared` from
 * importing a bounded context. Identity binds it to the issuer that also mints
 * the tokens, because reading and writing them are one decision.
 */
export const ACCESS_TOKEN_VERIFIER = Symbol('AccessTokenVerifier');

export interface AccessTokenVerifier {
  /** `null` for every way a token can be unacceptable — expired, altered, foreign, malformed. */
  verifyAccessToken(token: string): Principal | null;
}

/**
 * The only place a request becomes a caller. The access token is short-lived on
 * purpose: revoking a session cannot reach one already issued, so the window in
 * which a revoked session still works is the token's own lifetime and nothing
 * longer.
 *
 * It lives in `shared` rather than in the identity context because every
 * context puts it in front of its routes and none of them may import another's
 * internals — the same reason `Principal` next door is shared. The cookie name
 * comes from `@fca/contracts`, which is where both sides of the wire already
 * read it.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(ACCESS_TOKEN_VERIFIER) private readonly tokens: AccessTokenVerifier) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = request.cookies[SESSION_COOKIE.access];
    const claims = token === undefined ? null : this.tokens.verifyAccessToken(token);

    // Expired, altered, signed with another key or simply absent — one answer
    // for all of them, because the difference is not the caller's business.
    if (claims === null) throw new UnauthenticatedError('No valid access token was presented.');

    setPrincipal(claims);
    return true;
  }
}
