import { SessionFamilyId, type SessionId, type UserId } from '@fca/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  insertUser,
  startHarness,
  type Harness,
} from '../../../shared/persistence/__tests__/harness';
import { sessionTokens, sessions } from '../../../shared/persistence/schema';
import type { NewSession } from '../../application/ports/session.repository';
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

const newSession = (overrides: Partial<NewSession> = {}): NewSession => ({
  familyId: SessionFamilyId.trusted(crypto.randomUUID()),
  tokenHash: hashOf('a'),
  device: 'Firefox on macOS',
  ipHash: hashOf('f'),
  expiresAt: new Date(Date.now() + 30 * DAY),
  ...overrides,
});

const liveTokens = async (sessionId: SessionId): Promise<string[]> => {
  const rows = await h.db
    .select({ hash: sessionTokens.hash, supersededAt: sessionTokens.supersededAt })
    .from(sessionTokens)
    .where(eq(sessionTokens.sessionId, sessionId));

  return rows.filter((row) => row.supersededAt === null).map((row) => row.hash);
};

describe('creating a session', () => {
  it('stores the session and its first token together', async () => {
    const created = await repo.create({ userId: ada }, newSession());

    expect(created.userId).toBe(ada);
    expect(await liveTokens(created.id)).toEqual([hashOf('a')]);
  });
});

describe('rotating a refresh token', () => {
  it('supersedes the presented token and issues the next one', async () => {
    const created = await repo.create({ userId: ada }, newSession());

    const outcome = await repo.rotate(
      { presentedHash: hashOf('a'), nextHash: hashOf('b'), expiresAt: new Date(Date.now() + DAY) },
      new Date(),
    );

    expect(outcome.kind).toBe('rotated');
    expect(await liveTokens(created.id)).toEqual([hashOf('b')]);
  });

  it('extends the stored expiry so a tab left open overnight still works', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    const extended = new Date(Date.now() + 60 * DAY);

    await repo.rotate(
      { presentedHash: hashOf('a'), nextHash: hashOf('b'), expiresAt: extended },
      new Date(),
    );

    // Read back through the query builder, which is the only path that turns a
    // timestamptz into a Date — so this asserts what the row holds, not what
    // was passed in.
    const [row] = await h.db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, created.id));

    expect(row?.expiresAt).toEqual(extended);
    expect(created.expiresAt.getTime()).toBeLessThan(extended.getTime());
  });

  it('reports a token that was already rotated away as reuse, with its lineage', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    await repo.rotate(
      { presentedHash: hashOf('a'), nextHash: hashOf('b'), expiresAt: new Date(Date.now() + DAY) },
      new Date(),
    );

    // The thief presents the copy they took before the real client refreshed.
    const outcome = await repo.rotate(
      { presentedHash: hashOf('a'), nextHash: hashOf('c'), expiresAt: new Date(Date.now() + DAY) },
      new Date(),
    );

    expect(outcome).toEqual({
      kind: 'reused',
      sessionId: created.id,
      familyId: created.familyId,
    });
  });

  it('leaves the live token alone when a superseded one is presented', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    const request = (next: string) => ({
      presentedHash: hashOf('a'),
      nextHash: next,
      expiresAt: new Date(Date.now() + DAY),
    });
    await repo.rotate(request(hashOf('b')), new Date());

    await repo.rotate(request(hashOf('c')), new Date());

    // Detecting reuse must not also hand the thief a working token.
    expect(await liveTokens(created.id)).toEqual([hashOf('b')]);
  });

  it('does not know a token it never issued', async () => {
    await repo.create({ userId: ada }, newSession());

    const outcome = await repo.rotate(
      { presentedHash: hashOf('z'), nextHash: hashOf('b'), expiresAt: new Date(Date.now() + DAY) },
      new Date(),
    );

    expect(outcome).toEqual({ kind: 'unknown' });
  });

  it('refuses a live token whose session was revoked, without calling it theft', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    await repo.revoke({ userId: ada }, created.id, new Date());

    const outcome = await repo.rotate(
      { presentedHash: hashOf('a'), nextHash: hashOf('b'), expiresAt: new Date(Date.now() + DAY) },
      new Date(),
    );

    // A signed-out session is dead, not stolen — there is no lineage left to cut.
    expect(outcome).toEqual({ kind: 'unknown' });
  });

  it('refuses a live token whose session has expired', async () => {
    const created = await repo.create({ userId: ada }, newSession());

    const outcome = await repo.rotate(
      { presentedHash: hashOf('a'), nextHash: hashOf('b'), expiresAt: new Date(Date.now() + DAY) },
      new Date(created.expiresAt.getTime() + 1_000),
    );

    expect(outcome).toEqual({ kind: 'unknown' });
  });

  it('lets exactly one of two simultaneous refreshes through', async () => {
    const created = await repo.create({ userId: ada }, newSession());
    const attempt = (next: string) =>
      repo.rotate(
        { presentedHash: hashOf('a'), nextHash: next, expiresAt: new Date(Date.now() + DAY) },
        new Date(),
      );

    const [first, second] = await Promise.all([attempt(hashOf('b')), attempt(hashOf('c'))]);

    // The loser is reported as reuse, because from the database's side it is
    // indistinguishable from a stolen copy. Whether a benign race should be
    // treated more gently is a policy decision for the use case in M4.3.
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['reused', 'rotated']);
    expect(await liveTokens(created.id)).toHaveLength(1);
  });
});

describe('listing sessions', () => {
  it('shows only your own, newest use first', async () => {
    const older = await repo.create({ userId: ada }, newSession({ device: 'Safari' }));
    await repo.create({ userId: ada }, newSession({ tokenHash: hashOf('b'), device: 'Firefox' }));
    await repo.create({ userId: grace }, newSession({ tokenHash: hashOf('c'), device: 'Chrome' }));

    await repo.rotate(
      { presentedHash: hashOf('a'), nextHash: hashOf('d'), expiresAt: older.expiresAt },
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
