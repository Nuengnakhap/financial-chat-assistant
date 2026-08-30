import { SessionFamilyId, type SessionId, type UserId } from '@fca/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  insertUser,
  startHarness,
  type Harness,
} from '../../../shared/persistence/__tests__/harness';
import { sessionTokens, sessions } from '../../../shared/persistence/schema';
import type { NewSession, RotationRequest } from '../../application/ports/session.repository';
import { DrizzleSessionRepository } from '../drizzle-session.repository';

let h: Harness;
let repo: DrizzleSessionRepository;
let ada: UserId;
let grace: UserId;

beforeAll(async () => {
  h = await startHarness();
  repo = new DrizzleSessionRepository(h.db);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  ada = await insertUser(h.db, 'ada@example.com');
  grace = await insertUser(h.db, 'grace@example.com');
});

const hashOf = (label: string): string => label.repeat(64).slice(0, 64);
const DAY = 86_400_000;
const GRACE_MS = 10_000;

const newSession = (overrides: Partial<NewSession> = {}): NewSession => ({
  familyId: SessionFamilyId.trusted(crypto.randomUUID()),
  tokenHash: hashOf('a'),
  device: 'Firefox on macOS',
  ipHash: hashOf('f'),
  expiresAt: new Date(Date.now() + 30 * DAY),
  absoluteExpiresAt: new Date(Date.now() + 90 * DAY),
  ...overrides,
});

/**
 * Strict by default, so a test that means "this should be treated as theft"
 * does not have to say so, and the two that exercise the window say so loudly.
 */
const rotation = (
  presented: string,
  next: string,
  overrides: Partial<RotationRequest> = {},
): RotationRequest => ({
  presentedHash: hashOf(presented),
  nextHash: hashOf(next),
  expiresAt: new Date(Date.now() + DAY),
  reuseGraceMs: 0,
  ...overrides,
});

const liveTokens = async (sessionId: SessionId): Promise<string[]> => {
  const rows = await h.db
    .select({ hash: sessionTokens.hash, supersededAt: sessionTokens.supersededAt })
    .from(sessionTokens)
    .where(eq(sessionTokens.sessionId, sessionId));

  return rows.filter((row) => row.supersededAt === null).map((row) => row.hash);
};

const storedExpiry = async (sessionId: SessionId): Promise<Date | undefined> => {
  const [row] = await h.db
    .select({ expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId));

  return row?.expiresAt;
};

describe('creating a session', () => {
  it('stores the session and its first token together', async () => {
    const created = await repo.create({ userId: ada }, newSession());

    expect(created.userId).toBe(ada);
    expect(await liveTokens(created.id)).toEqual([hashOf('a')]);
  });

  it('never starts a session that outlives its own cap', async () => {
    const cap = new Date(Date.now() + DAY);

    const created = await repo.create(
      { userId: ada },
      newSession({ expiresAt: new Date(Date.now() + 30 * DAY), absoluteExpiresAt: cap }),
    );

    expect(created.expiresAt).toEqual(cap);
  });
});

describe('rotating a refresh token', () => {
  it('supersedes the presented token and issues the next one', async () => {
    const created = await repo.create({ userId: ada }, newSession());

    const outcome = await repo.rotate(rotation('a', 'b'), new Date());

    expect(outcome.kind).toBe('rotated');
    expect(await liveTokens(created.id)).toEqual([hashOf('b')]);
  });

  it('extends the stored expiry so a tab left open overnight still works', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    const extended = new Date(Date.now() + 60 * DAY);

    await repo.rotate(rotation('a', 'b', { expiresAt: extended }), new Date());

    // Read back through the query builder, which is the only path that turns a
    // timestamptz into a Date — so this asserts what the row holds.
    expect(await storedExpiry(created.id)).toEqual(extended);
    expect(created.expiresAt.getTime()).toBeLessThan(extended.getTime());
  });

  it('will not slide the expiry past the absolute cap', async () => {
    const cap = new Date(Date.now() + 2 * DAY);
    const created = await repo.create({ userId: ada }, newSession({ absoluteExpiresAt: cap }));

    const outcome = await repo.rotate(
      rotation('a', 'b', { expiresAt: new Date(Date.now() + 400 * DAY) }),
      new Date(),
    );

    // A session refreshed every day for a year still ends when the cap says so.
    expect(outcome.kind === 'rotated' && outcome.session.expiresAt).toEqual(cap);
    expect(await storedExpiry(created.id)).toEqual(cap);
  });

  it('stops refreshing once the cap has passed', async () => {
    const cap = new Date(Date.now() + 2 * DAY);
    await repo.create({ userId: ada }, newSession({ absoluteExpiresAt: cap }));

    const outcome = await repo.rotate(rotation('a', 'b'), new Date(cap.getTime() + 1_000));

    expect(outcome).toEqual({ kind: 'unknown' });
  });

  it('reports a token that was already rotated away as reuse, with its lineage', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    await repo.rotate(rotation('a', 'b'), new Date());

    // The thief presents the copy they took before the real client refreshed.
    const outcome = await repo.rotate(rotation('a', 'c'), new Date());

    expect(outcome).toEqual({
      kind: 'reused',
      sessionId: created.id,
      familyId: created.familyId,
    });
  });

  it('leaves the live token alone when a superseded one is presented', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    await repo.rotate(rotation('a', 'b'), new Date());

    await repo.rotate(rotation('a', 'c'), new Date());

    // Detecting reuse must not also hand the thief a working token.
    expect(await liveTokens(created.id)).toEqual([hashOf('b')]);
  });

  it('does not know a token it never issued', async () => {
    await repo.create({ userId: ada }, newSession());

    const outcome = await repo.rotate(rotation('z', 'b'), new Date());

    expect(outcome).toEqual({ kind: 'unknown' });
  });

  it('refuses a live token whose session was revoked, without calling it theft', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    await repo.revoke({ userId: ada }, created.id, new Date());

    const outcome = await repo.rotate(rotation('a', 'b'), new Date());

    // A signed-out session is dead, not stolen — there is no lineage left to cut.
    expect(outcome).toEqual({ kind: 'unknown' });
  });

  it('refuses a live token whose session has expired', async () => {
    const created = await repo.create({ userId: ada }, newSession());

    const outcome = await repo.rotate(
      rotation('a', 'b'),
      new Date(created.expiresAt.getTime() + 1_000),
    );

    expect(outcome).toEqual({ kind: 'unknown' });
  });

  it('lets exactly one of two simultaneous refreshes through', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    const attempt = (next: string) => repo.rotate(rotation('a', next), new Date());

    const [first, second] = await Promise.all([attempt('b'), attempt('c')]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['reused', 'rotated']);
    expect(await liveTokens(created.id)).toHaveLength(1);
  });

  it('calls the loser of that race a race, not a theft, inside the grace window', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    const attempt = (next: string) =>
      repo.rotate(rotation('a', next, { reuseGraceMs: GRACE_MS }), new Date());

    const [first, second] = await Promise.all([attempt('b'), attempt('c')]);

    // Both tabs belong to the same person; signing them out everywhere for
    // opening a second one is worse than the replay it would have caught.
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['raced', 'rotated']);
    expect(await liveTokens(created.id)).toHaveLength(1);
  });

  it('still calls a replay outside the window a theft, however wide the window', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    const rotatedAt = new Date();
    await repo.rotate(rotation('a', 'b', { reuseGraceMs: GRACE_MS }), rotatedAt);

    const outcome = await repo.rotate(
      rotation('a', 'c', { reuseGraceMs: GRACE_MS }),
      new Date(rotatedAt.getTime() + GRACE_MS + 1_000),
    );

    expect(outcome).toEqual({
      kind: 'reused',
      sessionId: created.id,
      familyId: created.familyId,
    });
  });
});

describe('listing sessions', () => {
  it('shows only your own, newest use first', async () => {
    const older = await repo.create({ userId: ada }, newSession({ device: 'Safari' }));
    await repo.create({ userId: ada }, newSession({ tokenHash: hashOf('b'), device: 'Firefox' }));
    await repo.create({ userId: grace }, newSession({ tokenHash: hashOf('c'), device: 'Chrome' }));

    await repo.rotate(
      rotation('a', 'd', { expiresAt: older.expiresAt }),
      new Date(Date.now() + 1_000),
    );

    const mine = await repo.listForOwner({ userId: ada }, 10, new Date());

    expect(mine.map((row) => row.device)).toEqual(['Safari', 'Firefox']);
  });

  it('hides revoked and expired ones', async () => {
    const revoked = await repo.create({ userId: ada }, newSession());
    await repo.create({ userId: ada }, newSession({ tokenHash: hashOf('b') }));
    await repo.revoke({ userId: ada }, revoked.id, new Date());

    expect(await repo.listForOwner({ userId: ada }, 10, new Date())).toHaveLength(1);
    expect(await repo.listForOwner({ userId: ada }, 10, new Date(Date.now() + 31 * DAY))).toEqual(
      [],
    );
  });

  it('never returns more than asked for, however often the user signs in', async () => {
    await Promise.all(
      ['a', 'b', 'c'].map((label) =>
        repo.create({ userId: ada }, newSession({ tokenHash: hashOf(label) })),
      ),
    );

    expect(await repo.listForOwner({ userId: ada }, 2, new Date())).toHaveLength(2);
  });
});

describe('revoking', () => {
  it('succeeds once and only once', async () => {
    const created = await repo.create({ userId: ada }, newSession());

    expect(await repo.revoke({ userId: ada }, created.id, new Date())).toBe(true);
    expect(await repo.revoke({ userId: ada }, created.id, new Date())).toBe(false);
  });

  it('refuses to revoke a session that is not yours', async () => {
    const created = await repo.create({ userId: ada }, newSession());

    expect(await repo.revoke({ userId: grace }, created.id, new Date())).toBe(false);
    expect(await repo.listForOwner({ userId: ada }, 10, new Date())).toHaveLength(1);
  });

  it('cuts a whole lineage and leaves other families alone', async () => {
    const family = SessionFamilyId.trusted(crypto.randomUUID());
    const compromised = await repo.create({ userId: ada }, newSession({ familyId: family }));
    await repo.revoke({ userId: ada }, compromised.id, new Date());
    // A family only has one live session at a time, so the next link is created
    // after the first is gone — revoking the family must still reach it.
    await repo.create({ userId: ada }, newSession({ familyId: family, tokenHash: hashOf('b') }));
    const elsewhere = await repo.create({ userId: ada }, newSession({ tokenHash: hashOf('c') }));

    expect(await repo.revokeFamily(family, new Date())).toBe(1);

    const left = await repo.listForOwner({ userId: ada }, 10, new Date());
    expect(left.map((row) => row.id)).toEqual([elsewhere.id]);
  });

  it('reports nothing revoked when the lineage is already dead', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    await repo.revokeFamily(created.familyId, new Date());

    expect(await repo.revokeFamily(created.familyId, new Date())).toBe(0);
  });
});
