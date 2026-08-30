import { UnauthenticatedError } from '@fca/domain';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { ACCESS_COOKIE } from './session-cookies';
import { setPrincipal } from '../../shared/http/request-context';
import { TOKEN_ISSUER, type TokenIssuer } from '../application/ports/token-issuer';

/**
 * The only place a request becomes a caller. The access token is short-lived on
 * purpose: revoking a session cannot reach one already issued, so the window in
 * which a revoked session still works is the token's own lifetime and nothing
 * longer.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuer) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = request.cookies[ACCESS_COOKIE];
    const claims = token === undefined ? null : this.tokens.verifyAccessToken(token);

    // Expired, altered, signed with another key or simply absent — one answer
    // for all of them, because the difference is not the caller's business.
    if (claims === null) throw new UnauthenticatedError('No valid access token was presented.');

    setPrincipal(claims);
    return true;
  }
}
