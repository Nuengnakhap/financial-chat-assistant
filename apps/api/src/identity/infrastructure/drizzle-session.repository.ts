import type { OwnerScope, SessionFamilyId, SessionId, UserId } from '@fca/domain';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import type { DbOrTx } from '../../shared/persistence/db-or-tx';
import { sessions, sessionTokens } from '../../shared/persistence/schema';
import type {
  ActiveSession,
  NewSession,
  RotationOutcome,
  RotationRequest,
  SessionRepository,
  SessionSummary,
} from '../application/ports/session.repository';

/**
 * `execute` hands back whatever the database called the columns, so these are
 * snake_case. The index signature is what `execute` requires of a row type.
 *
 * No `timestamptz` is selected here on purpose: raw `execute` skips the mapping
 * the query builder does, so one arrives as the text PostgreSQL prints rather
 * than a `Date`. Where a time really has to come back — the expiry after the
 * absolute cap has been applied to it — it is selected as epoch milliseconds in
 * a `float8`, which the driver does turn into a number.
 */
interface SessionColumns {
  readonly [column: string]: unknown;
  readonly id: string;
  readonly user_id: string;
  readonly family_id: string;
  readonly expires_at_ms: number;
}

interface PresentedTokenColumns {
  readonly [column: string]: unknown;
  readonly session_id: string;
  readonly family_id: string;
  readonly reused: boolean;
  readonly within_grace: boolean;
}

export class DrizzleSessionRepository implements SessionRepository {
  constructor(private readonly db: DbOrTx) {}

  /**
   * Both inserts are one statement so a session can never exist with no token
   * to refresh it — a caller that forgot to open a transaction would otherwise
   * leave one behind on any failure between the two.
   */
  async create(scope: OwnerScope, session: NewSession): Promise<ActiveSession> {
    const result = await this.db.execute<SessionColumns>(sql`
      WITH created AS (
        INSERT INTO ${sessions}
               (user_id, family_id, device, ip_hash, expires_at, absolute_expires_at)
        VALUES (${scope.userId}, ${session.familyId}, ${session.device}, ${session.ipHash},
                LEAST(${session.expiresAt}::timestamptz, ${session.absoluteExpiresAt}::timestamptz),
                ${session.absoluteExpiresAt})
        RETURNING id, user_id, family_id, expires_at
      ), issued AS (
        INSERT INTO ${sessionTokens} (hash, session_id)
        SELECT ${session.tokenHash}, id FROM created
      )
      SELECT id, user_id, family_id,
             EXTRACT(EPOCH FROM expires_at)::float8 * 1000 AS expires_at_ms
        FROM created
    `);

    const row = result.rows[0];
    if (row === undefined) throw new Error('session insert returned no row');

    return toActive(row);
  }

  async rotate(request: RotationRequest, now: Date): Promise<RotationOutcome> {
    const rotated = await this.attemptRotation(request, now);
    if (rotated !== null) return { kind: 'rotated', session: rotated };

    // Nothing moved. Either the token is unknown, or it is one we issued and
    // have already rotated away — which is the signal a copy of it exists.
    return await this.diagnose(request, now);
  }

  /**
   * The supersede and the insert are one statement, so the unique index on live
   * tokens is what settles a race rather than the order two round trips happen
   * to interleave in. `now` is passed rather than read from the server clock so
   * a test can put a session past its expiry without waiting for it.
   */
  private async attemptRotation(
    request: RotationRequest,
    now: Date,
  ): Promise<ActiveSession | null> {
    const result = await this.db.execute<SessionColumns>(sql`
      WITH superseded AS (
        UPDATE ${sessionTokens} AS t SET superseded_at = ${now}
          FROM ${sessions} AS s
         WHERE t.hash = ${request.presentedHash} AND t.superseded_at IS NULL
           -- No separate check on absolute_expires_at: the clamp below plus
           -- chk_sessions_within_absolute keep expires_at at or under it, so a
           -- session past its cap is already past this.
           AND s.id = t.session_id AND s.revoked_at IS NULL AND s.expires_at > ${now}
        RETURNING t.session_id
      ), issued AS (
        INSERT INTO ${sessionTokens} (hash, session_id, issued_at)
        SELECT ${request.nextHash}, session_id, ${now} FROM superseded
        RETURNING session_id
      )
      UPDATE ${sessions} SET last_used_at = ${now},
             -- The cap is applied here rather than trusted to the caller, and
             -- chk_sessions_within_absolute rejects the statement if it is not.
             expires_at = LEAST(${request.expiresAt}::timestamptz, absolute_expires_at)
       WHERE id IN (SELECT session_id FROM issued)
      RETURNING id, user_id, family_id,
                EXTRACT(EPOCH FROM expires_at)::float8 * 1000 AS expires_at_ms
    `);

    const row = result.rows[0];
    return row === undefined ? null : toActive(row);
  }

  private async diagnose(request: RotationRequest, now: Date): Promise<RotationOutcome> {
    const graceStart = new Date(now.getTime() - request.reuseGraceMs);
    const result = await this.db.execute<PresentedTokenColumns>(sql`
      SELECT t.session_id, s.family_id,
             (t.superseded_at IS NOT NULL) AS reused,
             (t.superseded_at > ${graceStart}) AS within_grace
        FROM ${sessionTokens} AS t JOIN ${sessions} AS s ON s.id = t.session_id
       WHERE t.hash = ${request.presentedHash}
    `);

    const row = result.rows[0];
    if (row === undefined) return { kind: 'unknown' };
    // A live token whose session is revoked or expired is a dead session, not a
    // theft: there is no lineage left to cut.
    if (!row.reused) return { kind: 'unknown' };

    /* eslint-disable @typescript-eslint/consistent-type-assertions --
       the row came from our own database, so the ids are known-good. */
    const sessionId = row.session_id as SessionId;
    if (row.within_grace) return { kind: 'raced', sessionId };

    return {
      kind: 'reused',
      sessionId,
      familyId: row.family_id as SessionFamilyId,
    };
    /* eslint-enable @typescript-eslint/consistent-type-assertions */
  }

  async listForOwner(
    scope: OwnerScope,
    limit: number,
    now: Date,
  ): Promise<readonly SessionSummary[]> {
    const rows = await this.db
      .select({
        id: sessions.id,
        device: sessions.device,
        ipHash: sessions.ipHash,
        lastUsedAt: sessions.lastUsedAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, scope.userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      )
      .orderBy(desc(sessions.lastUsedAt))
      .limit(limit);

    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    return rows.map((row) => ({ ...row, id: row.id as SessionId }));
  }

  async revoke(scope: OwnerScope, id: SessionId, now: Date): Promise<boolean> {
    // Ownership is part of the predicate: someone else's session is not found
    // rather than forbidden, so its existence cannot be probed.
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(
        and(eq(sessions.id, id), eq(sessions.userId, scope.userId), isNull(sessions.revokedAt)),
      )
      .returning({ id: sessions.id });

    return revoked.length === 1;
  }

  async revokeFamily(familyId: SessionFamilyId, now: Date): Promise<number> {
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return revoked.length;
  }
}

function toActive(row: SessionColumns): ActiveSession {
  /* eslint-disable @typescript-eslint/consistent-type-assertions --
     the only place a raw column becomes a branded id; the row is our own. */
  return {
    id: row.id as SessionId,
    userId: row.user_id as UserId,
    familyId: row.family_id as SessionFamilyId,
    // What the row holds after the cap was applied, which is not always what
    // the caller asked for.
    expiresAt: new Date(row.expires_at_ms),
  };
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
}
