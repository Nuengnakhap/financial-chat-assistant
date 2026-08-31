import { timingSafeEqual } from 'node:crypto';

import { CSRF_HEADER } from '@fca/contracts';
import { ForbiddenError } from '@fca/domain';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE } from './session-cookies';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The second line after `SameSite=Strict`, which older browsers and a few
 * navigation cases do not honour. A cross-site page can make the browser send
 * the cookies, but it cannot read one, so requiring a header that must equal a
 * readable cookie is a proof the request came from our own script.
 *
 * Applies only when the browser has something to forge with. A request carrying
 * no session cookie can be replayed from anywhere without gaining anything, and
 * demanding a token there would mean registering and signing in could not work.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(request.method)) return true;

    const cookies = request.cookies;
    const carriesSession =
      cookies[ACCESS_COOKIE] !== undefined || cookies[REFRESH_COOKIE] !== undefined;
    if (!carriesSession) return true;

    const expected = cookies[CSRF_COOKIE];
    const presented = request.headers[CSRF_HEADER];
    if (expected === undefined || typeof presented !== 'string' || !equal(expected, presented)) {
      throw new ForbiddenError('CSRF token missing or did not match.');
    }

    return true;
  }
}

function equal(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  // Compared in constant time and length-checked first, because
  // `timingSafeEqual` throws rather than returning false on a length mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}
