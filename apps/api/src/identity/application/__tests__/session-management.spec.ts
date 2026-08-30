import { NotFoundError, isErr, isOk } from '@fca/domain';
import { describe, expect, it, vi } from 'vitest';

import { fakeSessions, fakeUnitOfWork } from './fakes';
import { testConfig } from '../../../shared/config/__tests__/test-config';
import type { Principal } from '../../../shared/http/request-context';
import { ListSessionsUseCase } from '../use-cases/list-sessions.use-case';
import { PurgeDeadSessionsUseCase } from '../use-cases/purge-dead-sessions.use-case';
import { RevokeSessionUseCase } from '../use-cases/revoke-session.use-case';

const USER = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const MINE = '01936d1e-8f7a-7c3e-b8d4-9a1e2f3b4c5d';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const PRINCIPAL = { userId: USER, sessionId: MINE } as unknown as Principal;

const summary = (id: string, device: string) => ({
  id: id as never,
  device,
  ipHash: 'f'.repeat(64),
  lastUsedAt: new Date('2026-08-30T00:00:00Z'),
});

describe('listing sessions', () => {
  it('marks the one the request arrived on', async () => {
    const { uow } = fakeUnitOfWork({
      sessions: fakeSessions({
        listForOwner: () => Promise.resolve([summary(MINE, 'Firefox'), summary(OTHER, 'Safari')]),
      }),
    });

    const listed = await new ListSessionsUseCase(uow).execute(PRINCIPAL);

    expect(listed.map((s) => s.current)).toEqual([true, false]);
  });

  it('asks only for the caller, and never for an unbounded number', async () => {
    const listForOwner = vi.fn(() => Promise.resolve([]));
    const { uow } = fakeUnitOfWork({ sessions: fakeSessions({ listForOwner }) });

    await new ListSessionsUseCase(uow).execute(PRINCIPAL, new Date('2026-08-30T12:00:00Z'));

    // Ownership is a parameter of the query, not something checked afterwards.
    expect(listForOwner).toHaveBeenCalledWith(
      { userId: USER },
      100,
      new Date('2026-08-30T12:00:00Z'),
    );
  });
});

describe('revoking a session', () => {
  it('ends one that belongs to the caller', async () => {
    const revoke = vi.fn(() => Promise.resolve(true));
    const { uow } = fakeUnitOfWork({ sessions: fakeSessions({ revoke }) });

    const now = new Date('2026-08-30T09:00:00Z');
    const result = await new RevokeSessionUseCase(uow).execute(PRINCIPAL, OTHER, now);

    expect(isOk(result)).toBe(true);
    expect(revoke).toHaveBeenCalledWith({ userId: USER }, OTHER, now);
  });

  it.each([
    ["someone else's, or one that never existed", false, OTHER],
    ['an id that is not even a uuid', false, 'not-a-uuid'],
  ])('answers not-found for %s', async (_name, revoked, id) => {
    const { uow } = fakeUnitOfWork({
      sessions: fakeSessions({ revoke: () => Promise.resolve(revoked) }),
    });

    const result = await new RevokeSessionUseCase(uow).execute(PRINCIPAL, id);

    // The same answer for both, so which ids exist cannot be probed by asking.
    expect(isErr(result) && result.error).toBeInstanceOf(NotFoundError);
  });

  it('never reaches the database with a malformed id', async () => {
    const revoke = vi.fn(() => Promise.resolve(true));
    const { uow } = fakeUnitOfWork({ sessions: fakeSessions({ revoke }) });

    await new RevokeSessionUseCase(uow).execute(PRINCIPAL, 'not-a-uuid');

    expect(revoke).not.toHaveBeenCalled();
  });
});

describe('purging dead sessions', () => {
  it('cuts at the retention window, counted back from now', async () => {
    const deleteDeadBefore = vi.fn(() => Promise.resolve(3));
    const { uow } = fakeUnitOfWork({ sessions: fakeSessions({ deleteDeadBefore }) });
    const now = new Date('2026-08-30T00:00:00Z');

    const removed = await new PurgeDeadSessionsUseCase(uow, testConfig()).execute(now);

    expect(removed).toBe(3);
    // 30 days by default, and the boundary is the thing worth pinning: an
    // off-by-one here either keeps everything or deletes evidence early.
    expect(deleteDeadBefore).toHaveBeenCalledWith(new Date('2026-07-31T00:00:00Z'));
  });
});
