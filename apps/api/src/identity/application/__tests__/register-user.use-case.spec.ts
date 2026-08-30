import { ConflictError, Err, RateLimitedError, isErr, isOk } from '@fca/domain';
import { describe, expect, it, vi } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import { CredentialPolicy } from '../credential-policy';
import { SessionIssuer } from '../session-issuer';
import {
  activeSession,
  fakePasswords,
  fakeSessions,
  fakeThrottle,
  fakeTokens,
  fakeUnitOfWork,
  fakeUsers,
  storedUser,
  type FakeThrottle,
} from './fakes';
import { RegisterUserUseCase } from '../use-cases/register-user.use-case';

const COMMAND = {
  email: '  Ada@example.com  ',
  password: 'correct-horse-battery',
  displayName: '  Ada  ',
  device: 'Firefox on macOS',
  ipHash: 'f'.repeat(64),
};

function build(options: { taken?: boolean; throttle?: FakeThrottle } = {}) {
  const create = vi.fn(() => Promise.resolve(options.taken === true ? null : storedUser()));
  const createSession = vi.fn(() => Promise.resolve(activeSession()));
  const hash = vi.fn(() => Promise.resolve('argon2-hash'));
  const throttle = options.throttle ?? fakeThrottle();

  const { uow } = fakeUnitOfWork({
    users: fakeUsers({ create }),
    sessions: fakeSessions({ create: createSession }),
  });
  const credentials = new CredentialPolicy(fakePasswords({ hash }), throttle.throttle);
  const issuer = new SessionIssuer(fakeTokens(), testConfig());

  return {
    useCase: new RegisterUserUseCase(uow, credentials, issuer),
    create,
    createSession,
    hash,
    throttle,
  };
}

describe('registering', () => {
  it('stores the user and signs them straight in', async () => {
    const { useCase, createSession } = build();

    const result = await useCase.execute(COMMAND);

    expect(isOk(result) && result.value.user.email).toBe('ada@example.com');
    expect(isOk(result) && result.value.session.accessToken).toContain('access:');
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('trims what a form left around the edges', async () => {
    const { useCase, create } = build();

    await useCase.execute(COMMAND);

    expect(create).toHaveBeenCalledWith({
      email: 'Ada@example.com',
      displayName: 'Ada',
      passwordHash: 'argon2-hash',
    });
  });

  it('never stores the password itself', async () => {
    const { useCase, create, hash } = build();

    await useCase.execute(COMMAND);

    expect(hash).toHaveBeenCalledWith(COMMAND.password);
    expect(JSON.stringify(create.mock.calls)).not.toContain(COMMAND.password);
  });

  it('reports a taken address and opens no session for it', async () => {
    const { useCase, createSession } = build({ taken: true });

    const result = await useCase.execute(COMMAND);

    expect(isErr(result) && result.error).toBeInstanceOf(ConflictError);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('counts the attempt by host, so asking is not free', async () => {
    const { useCase, throttle } = build();

    await useCase.execute(COMMAND);

    // Saying whether an address is taken is the same disclosure signing in
    // makes, and signing in is counted — this door has to cost something too.
    expect(throttle.recordRegistration).toHaveBeenCalledWith(COMMAND.ipHash);
  });

  it('never counts the attempt by address', async () => {
    const { useCase, throttle } = build({ taken: true });

    await useCase.execute(COMMAND);

    // Otherwise registering a victim's email over and over would lock them out
    // of signing in, which is a worse hole than the one being closed.
    expect(throttle.recordSignIn).not.toHaveBeenCalled();
  });

  it('turns the attempt away before hashing when the host has asked too often', async () => {
    const throttle = fakeThrottle({
      recordRegistration: vi.fn(() =>
        Promise.resolve(Err(new RateLimitedError('Too many attempts.', 60))),
      ),
    });
    const { useCase, hash, create } = build({ throttle });

    const result = await useCase.execute(COMMAND);

    expect(isErr(result) && result.error).toBeInstanceOf(RateLimitedError);
    // Registering is the only unauthenticated path that spends argon2, so the
    // limit has to land ahead of it rather than after.
    expect(hash).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
