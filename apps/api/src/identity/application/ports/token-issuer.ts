import type { SessionId, UserId } from '@fca/domain';

/** Everything a request needs to know about who is making it. */
export interface AccessTokenClaims {
  readonly userId: UserId;
  readonly sessionId: SessionId;
}

export interface IssuedRefreshToken {
  /** Sent to the browser. Never stored anywhere. */
  readonly token: string;
  /** Stored instead of the token, so a database copy is not a set of live keys. */
  readonly hash: string;
  readonly expiresAt: Date;
}

export interface TokenIssuer {
  issueAccessToken(claims: AccessTokenClaims): string;

  /** `null` for every way a token can be unacceptable — expired, altered, foreign, malformed. */
  verifyAccessToken(token: string): AccessTokenClaims | null;

  issueRefreshToken(): IssuedRefreshToken;

  /** The same function the issuer used, so a presented token can be looked up. */
  hashRefreshToken(token: string): string;
}
