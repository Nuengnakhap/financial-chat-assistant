import type { AppConfig } from '@fca/config';
import { SessionFamilyId, type SessionId, type UserId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import type { SessionRepository } from './ports/session.repository';
import { TOKEN_ISSUER, type TokenIssuer } from './ports/token-issuer';
import { APP_CONFIG } from '../../shared/config/app-config.token';

const MS_PER_DAY = 86_400_000;

export interface SessionRequest {
  readonly userId: UserId;
  readonly device: string;
  /** Hashed at the edge: nothing below presentation is handed an address. */
  readonly ipHash: string;
}

export interface IssuedSession {
  readonly accessToken: string;
  /** The only moment this value exists outside the browser. Never stored, never logged. */
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

/**
 * What `rotate` answered, with the tokens already minted where there are any.
 * The three failing shapes are kept apart because only one of them means a
 * lineage has to be cut.
 */
export type RenewalOutcome =
  | { readonly kind: 'renewed'; readonly session: IssuedSession }
  | { readonly kind: 'reused'; readonly sessionId: SessionId; readonly familyId: SessionFamilyId }
  | { readonly kind: 'raced' }
  | { readonly kind: 'unknown' };

/**
 * Every path that hands a browser a token comes through here, so the lifetimes
 * and the order things are minted in are decided once. The repository is a
 * parameter rather than a dependency because it belongs to whichever
 * transaction the caller opened.
 */
@Injectable()
export class SessionIssuer {
  constructor(
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The refresh token is minted first so its hash is what the session is created
   * with, and the access token last so it can carry the session's own id.
   */
  async issue(
    sessions: SessionRepository,
    request: SessionRequest,
    now = new Date(),
  ): Promise<IssuedSession> {
    const refresh = this.tokens.issueRefreshToken();

    const session = await sessions.create(
      { userId: request.userId },
      {
        // A new sign-in starts its own lineage, so revoking one for reuse leaves
        // every other device signed in.
        familyId: SessionFamilyId.trusted(crypto.randomUUID()),
        tokenHash: refresh.hash,
        device: request.device,
        ipHash: request.ipHash,
        expiresAt: refresh.expiresAt,
        absoluteExpiresAt: new Date(
          now.getTime() + this.config.auth.sessionAbsoluteTtlDays * MS_PER_DAY,
        ),
      },
    );

    return this.tokensFor(session, refresh.token);
  }

  /** The next token is minted before the swap, because its hash is what the swap writes. */
  async renew(
    sessions: SessionRepository,
    presented: string,
    now = new Date(),
  ): Promise<RenewalOutcome> {
    const next = this.tokens.issueRefreshToken();

    const outcome = await sessions.rotate(
      {
        presentedHash: this.tokens.hashRefreshToken(presented),
        nextHash: next.hash,
        expiresAt: next.expiresAt,
        reuseGraceMs: this.config.auth.refreshReuseGraceMs,
      },
      now,
    );

    if (outcome.kind !== 'rotated') return outcome;

    return { kind: 'renewed', session: this.tokensFor(outcome.session, next.token) };
  }

  private tokensFor(
    session: { readonly id: SessionId; readonly userId: UserId; readonly expiresAt: Date },
    refreshToken: string,
  ): IssuedSession {
    return {
      accessToken: this.tokens.issueAccessToken({
        userId: session.userId,
        sessionId: session.id,
      }),
      refreshToken,
      // What the row actually holds, which the absolute cap may have brought forward.
      refreshExpiresAt: session.expiresAt,
    };
  }
}
