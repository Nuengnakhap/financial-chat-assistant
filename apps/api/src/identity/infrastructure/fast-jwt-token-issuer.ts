import { createHash, randomBytes } from 'node:crypto';

import type { AppConfig } from '@fca/config';
import { SessionId, UserId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';
import { createSigner, createVerifier } from 'fast-jwt';

import { APP_CONFIG } from '../../shared/config/app-config.token';
import type {
  AccessTokenClaims,
  IssuedRefreshToken,
  TokenIssuer,
} from '../application/ports/token-issuer';

const ALGORITHM = 'HS256';
/** 256 bits, so guessing one is not a strategy. */
const REFRESH_TOKEN_BYTES = 32;
const MS_PER_DAY = 86_400_000;

interface AccessTokenPayload {
  readonly sub?: unknown;
  readonly sid?: unknown;
}

/**
 * The access token is read only by this application, so JWT buys nothing but a
 * shape everyone already knows. What it does buy is not touching the database on
 * every request — which is also why it is short-lived: revoking a session cannot
 * reach a token already issued, so the window has to be small.
 *
 * The refresh token is opaque instead, because it *is* checked against the
 * database, and there is nothing for a client to read in it.
 */
@Injectable()
export class FastJwtTokenIssuer implements TokenIssuer {
  // The synchronous overloads: `createSigner` returns a promise-returning
  // function only when the key is fetched lazily, which ours is not.
  private readonly sign: (payload: AccessTokenPayload) => string;
  private readonly verify: (token: string) => unknown;
  private readonly refreshTtlMs: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.sign = createSigner({
      key: config.auth.jwtSecret,
      algorithm: ALGORITHM,
      expiresIn: config.auth.accessTokenTtlMs,
    });
    // The allowlist is what makes `alg` in the header not worth lying about.
    this.verify = createVerifier({ key: config.auth.jwtSecret, algorithms: [ALGORITHM] });
    this.refreshTtlMs = config.auth.refreshTokenTtlDays * MS_PER_DAY;
  }

  issueAccessToken(claims: AccessTokenClaims): string {
    return this.sign({ sub: claims.userId, sid: claims.sessionId });
  }

  verifyAccessToken(token: string): AccessTokenClaims | null {
    let payload: AccessTokenPayload;
    try {
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions --
         fast-jwt returns the payload as `any`; the shape is checked below. */
      payload = this.verify(token) as AccessTokenPayload;
    } catch {
      // Expired, altered, signed with another key, or not a token at all. The
      // caller gets the same answer for all of them.
      return null;
    }

    const { sub, sid } = payload;
    if (typeof sub !== 'string' || typeof sid !== 'string') return null;
    if (!UserId.is(sub) || !SessionId.is(sid)) return null;

    return { userId: UserId.trusted(sub), sessionId: SessionId.trusted(sid) };
  }

  issueRefreshToken(): IssuedRefreshToken {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    return {
      token,
      hash: this.hashRefreshToken(token),
      expiresAt: new Date(Date.now() + this.refreshTtlMs),
    };
  }

  /**
   * Plain SHA-256, not a password hash: the input is 256 bits of randomness we
   * generated, so there is no dictionary to slow down — only a lookup to make
   * constant, which a fixed-length digest already is.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
