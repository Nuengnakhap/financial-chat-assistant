import { Ok } from '@fca/domain';
import type {
  DomainEvent,
  RateLimitedError,
  Result,
  SessionFamilyId,
  SessionId,
  UserId,
} from '@fca/domain';
import { vi } from 'vitest';

import type { TxContext, UnitOfWork } from '../../../shared/persistence/unit-of-work';
import type { AuthThrottle } from '../ports/auth-throttle';
import type { PasswordHasher } from '../ports/password-hasher';
import type {
  ActiveSession,
  RotationOutcome,
  SessionRepository,
} from '../ports/session.repository';
import type { AccessTokenClaims, TokenIssuer } from '../ports/token-issuer';
import type { Credentials, StoredUser, UserRepository } from '../ports/user.repository';

const userId = (value = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'): UserId => value as UserId;

const sessionId = (value = '01936d1e-8f7a-7c3e-b8d4-9a1e2f3b4c5d'): SessionId => value as SessionId;

const familyId = (value = '7c9e6679-7425-40de-944b-e07fc1f90ae7'): SessionFamilyId =>
  value as SessionFamilyId;

export const storedUser = (overrides: Partial<StoredUser> = {}): StoredUser => ({
  id: userId(),
  email: 'ada@example.com',
  displayName: 'Ada',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

export const credentialsFor = (hash = 'stored-hash'): Credentials => ({
  user: storedUser(),
  passwordHash: hash,
});

export const activeSession = (overrides: Partial<ActiveSession> = {}): ActiveSession => ({
  id: sessionId(),
  userId: userId(),
  familyId: familyId(),
  expiresAt: new Date('2026-12-01T00:00:00Z'),
  ...overrides,
});

/** Every method throws, so a test that forgot to stub one finds out rather than passing. */
const unimplemented = (name: string) =>
  vi.fn(() => {
    throw new Error(`${name} was not expected to be called`);
  });

export const fakeSessions = (overrides: Partial<SessionRepository> = {}): SessionRepository => ({
  create: unimplemented('sessions.create'),
  rotate: unimplemented('sessions.rotate'),
  listForOwner: unimplemented('sessions.listForOwner'),
  revoke: unimplemented('sessions.revoke'),
  revokeFamily: unimplemented('sessions.revokeFamily'),
  deleteDeadBefore: unimplemented('sessions.deleteDeadBefore'),
  ...overrides,
});

export const fakeUsers = (overrides: Partial<UserRepository> = {}): UserRepository => ({
  findById: unimplemented('users.findById'),
  create: unimplemented('users.create'),
  findCredentialsByEmail: unimplemented('users.findCredentialsByEmail'),
  ...overrides,
});

export const fakeTokens = (overrides: Partial<TokenIssuer> = {}): TokenIssuer => ({
  issueAccessToken: (claims: AccessTokenClaims) => `access:${claims.sessionId}`,
  verifyAccessToken: () => null,
  issueRefreshToken: () => ({
    token: 'refresh-plaintext',
    hash: 'refresh-hash',
    expiresAt: new Date('2026-10-01T00:00:00Z'),
  }),
  hashRefreshToken: (token: string) => `hash:${token}`,
  ...overrides,
});

export const fakePasswords = (overrides: Partial<PasswordHasher> = {}): PasswordHasher => ({
  hash: () => Promise.resolve('hashed'),
  verify: () => Promise.resolve(true),
  ...overrides,
});

export interface FakeThrottle {
  readonly throttle: AuthThrottle;
  /** Held separately so an assertion never has to reference an unbound method. */
  readonly recordSignIn: AuthThrottle['recordSignIn'];
  readonly recordRegistration: AuthThrottle['recordRegistration'];
  readonly clearSignIn: AuthThrottle['clearSignIn'];
}

const allowed = (): Promise<Result<void, RateLimitedError>> => Promise.resolve(Ok(undefined));

export function fakeThrottle(
  overrides: Partial<Pick<AuthThrottle, 'recordSignIn' | 'recordRegistration'>> = {},
): FakeThrottle {
  const recordSignIn = overrides.recordSignIn ?? vi.fn(allowed);
  const recordRegistration = overrides.recordRegistration ?? vi.fn(allowed);
  const clearSignIn = vi.fn(() => Promise.resolve());
  return {
    throttle: { recordSignIn, recordRegistration, clearSignIn },
    recordSignIn,
    recordRegistration,
    clearSignIn,
  };
}

export interface FakeUnitOfWork {
  readonly uow: UnitOfWork;
  readonly published: DomainEvent[];
}

/**
 * Runs the work immediately with whatever repositories the test supplied, and
 * keeps the events so a test can assert that a state change and the
 * announcement of it happened in the same unit of work.
 */
export function fakeUnitOfWork(repositories: Partial<TxContext> = {}): FakeUnitOfWork {
  const published: DomainEvent[] = [];
  const uow: UnitOfWork = {
    run: async (work) =>
      // A test supplies only the repositories the path under test touches.
      await work({ publish: (event) => published.push(event), ...repositories } as TxContext),
  };

  return { uow, published };
}

export const rotationOutcome = {
  rotated: (session = activeSession()): RotationOutcome => ({ kind: 'rotated', session }),
  reused: (): RotationOutcome => ({ kind: 'reused', sessionId: sessionId(), familyId: familyId() }),
  raced: (): RotationOutcome => ({ kind: 'raced', sessionId: sessionId() }),
  unknown: (): RotationOutcome => ({ kind: 'unknown' }),
};
