import { randomBytes } from 'node:crypto';

import type { CookieSerializeOptions } from '@fastify/cookie';
import type { AppConfig } from '@fca/config';
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { APP_CONFIG } from '../../shared/config/app-config.token';
import type { IssuedSession } from '../application/session-issuer';

export const ACCESS_COOKIE = 'fca_access';
export const REFRESH_COOKIE = 'fca_refresh';
export const CSRF_COOKIE = 'fca_csrf';

/**
 * The refresh token is only ever presented to these routes, so the browser is
 * told not to send it anywhere else. Any other request carrying it is a request
 * that could have leaked it.
 */
const REFRESH_PATH = '/api/v1/auth';

/**
 * One shape for every cookie this app sets, and one place that decides it.
 * `sameSite: 'strict'` is the first line against CSRF and the token below is
 * the second; `httpOnly` is what makes a cross-site script unable to read a
 * session even if one gets in.
 */
@Injectable()
export class SessionCookies {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  set(reply: FastifyReply, session: IssuedSession): void {
    const refreshMaxAge = secondsUntil(session.refreshExpiresAt);

    reply.setCookie(ACCESS_COOKIE, session.accessToken, {
      ...this.base(),
      maxAge: Math.floor(this.config.auth.accessTokenTtlMs / 1_000),
    });
    reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      ...this.base(REFRESH_PATH),
      maxAge: refreshMaxAge,
    });
    // The only one JavaScript is meant to read: our client copies it into a
    // header, and a page on another origin can do neither.
    reply.setCookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
      ...this.base(),
      httpOnly: false,
      maxAge: refreshMaxAge,
    });
  }

  clear(reply: FastifyReply): void {
    // Cleared with the attributes they were set with — a cookie whose path does
    // not match is not replaced, it is joined by a second one.
    reply.clearCookie(ACCESS_COOKIE, this.base());
    reply.clearCookie(REFRESH_COOKIE, this.base(REFRESH_PATH));
    reply.clearCookie(CSRF_COOKIE, { ...this.base(), httpOnly: false });
  }

  private base(path = '/'): CookieSerializeOptions {
    return {
      httpOnly: true,
      secure: this.config.auth.cookieSecure,
      sameSite: 'strict',
      path,
    };
  }
}

/** Never negative: a browser reads `Max-Age=-1` as "delete", which is not the intent here. */
function secondsUntil(expiresAt: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000));
}
