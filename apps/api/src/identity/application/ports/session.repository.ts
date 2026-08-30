import type { OwnerScope, SessionFamilyId, SessionId, UserId } from '@fca/domain';

export interface NewSession {
  /** Rotation stays inside a family; only signing in again starts a new one. */
  readonly familyId: SessionFamilyId;
  readonly tokenHash: string;
  readonly device: string;
  readonly ipHash: string;
  readonly expiresAt: Date;
  /** Refreshing slides `expiresAt` forward; nothing slides past this. */
  readonly absoluteExpiresAt: Date;
}

export interface ActiveSession {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly familyId: SessionFamilyId;
  readonly expiresAt: Date;
}

/** What the session list renders. `current` is decided by the caller, not stored. */
export interface SessionSummary {
  readonly id: SessionId;
  readonly device: string;
  readonly ipHash: string;
  readonly lastUsedAt: Date;
}

export interface RotationRequest {
  readonly presentedHash: string;
  readonly nextHash: string;
  /**
   * Refreshing extends the session, so a tab left open overnight still works.
   * Clamped to the session's absolute expiry, which nothing can push past.
   */
  readonly expiresAt: Date;
  /**
   * How recently a token must have been rotated away for a second use of it to
   * count as two tabs racing rather than a stolen copy. Zero treats every one
   * as theft.
   */
  readonly reuseGraceMs: number;
}

/**
 * Four answers, not a nullable one. A caller holding `null` cannot tell a token
 * we never issued from one we rotated away a week ago, and only the second is
 * grounds for revoking an entire lineage.
 */
export type RotationOutcome =
  | { readonly kind: 'rotated'; readonly session: ActiveSession }
  | { readonly kind: 'reused'; readonly sessionId: SessionId; readonly familyId: SessionFamilyId }
  /**
   * Rotated away moments ago — two tabs refreshing together. This request still
   * fails, but the lineage survives, because signing someone out of every device
   * for opening a second tab is a worse outcome than the one it guards against:
   * a thief replaying inside the window gets no token either way.
   */
  | { readonly kind: 'raced'; readonly sessionId: SessionId }
  | { readonly kind: 'unknown' };

export interface SessionRepository {
  create(scope: OwnerScope, session: NewSession): Promise<ActiveSession>;

  /**
   * One statement decides everything: it supersedes the presented token and
   * issues the next one only if the first part matched something live. Reading
   * the row and then writing it would let two refreshes arriving together both
   * pass the read and both rotate.
   */
  rotate(request: RotationRequest, now: Date): Promise<RotationOutcome>;

  /** Bounded like every other listing here: nothing caps how often a user signs in. */
  listForOwner(scope: OwnerScope, limit: number, now: Date): Promise<readonly SessionSummary[]>;

  /** False when the session is already revoked, or is not the caller's. */
  revoke(scope: OwnerScope, id: SessionId, now: Date): Promise<boolean>;

  /**
   * The one method without an `OwnerScope`, because the caller that needs it has
   * no trusted user: reuse is detected from a token that may be a thief's. The
   * family id is safe because it came from our own row, not from the request.
   */
  revokeFamily(familyId: SessionFamilyId, now: Date): Promise<number>;
}
