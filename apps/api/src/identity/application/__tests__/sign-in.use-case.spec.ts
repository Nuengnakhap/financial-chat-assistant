import { Err, RateLimitedError, UnauthenticatedError, isErr, isOk } from '@fca/domain';
import { describe, expect, it, vi } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import { CredentialPolicy } from '../credential-policy';
import { SessionIssuer } from '../session-issuer';
import {
  activeSession,
  credentialsFor,
  fakePasswords,
  fakeSessions,
  fakeThrottle,
  fakeTokens,
  fakeUnitOfWork,
  fakeUsers,
  type FakeThrottle,
} from './fakes';
import { SignInUseCase } from '../use-cases/sign-in.use-case';

const COMMAND = {
  email: 'ada@example.com',
  password: 'correct-horse-battery',
  device: 'Firefox on macOS',
  ipHash: 'f'.repeat(64),
};

interface Options {
  readonly credentials?: ReturnType<typeof credentialsFor> | null;
  readonly matches?: boolean;
  readonly throttle?: FakeThrottle;
}

function build(options: Options = {}) {
  const throttle = options.throttle ?? fakeThrottle();
  const verify = vi.fn(() => Promise.resolve(options.matches ?? true));
  const created = vi.fn(() => Promise.resolve(activeSession()));

  const { uow } = fakeUnitOfWork({
    users: fakeUsers({
      findCredentialsByEmail: () => Promise.resolve(options.credentials ?? null),
    }),
    sessions: fakeSessions({ create: created }),
  });

  const credentials = new CredentialPolicy(fakePasswords({ verify }), throttle.throttle);
  const issuer = new SessionIssuer(fakeTokens(), testConfig());

  return { useCase: new SignInUseCase(uow, credentials, issuer), throttle, verify, created };
}

describe('signing in', () => {
  it('issues a session and stops the failures counting', async () => {
    const { useCase, throttle, created } = build({ credentials: credentialsFor() });

    const result = await useCase.execute(COMMAND);

    expect(isOk(result) && result.value.session.refreshToken).toBe('refresh-plaintext');
    expect(throttle.clearSignIn).toHaveBeenCalledWith(COMMAND.email);
    expect(created).toHaveBeenCalledOnce();
  });

  it('turns the attempt away before any password work when the window is full', async () => {
    const throttle = fakeThrottle({
      recordSignIn: vi.fn(() =>
        Promise.resolve(Err(new RateLimitedError('Too many attempts.', 120))),
      ),
    });
    const { useCase, verify, created } = build({ credentials: credentialsFor(), throttle });

    const result = await useCase.execute(COMMAND);

    const error = isErr(result) ? result.error : undefined;
    expect(error).toBeInstanceOf(RateLimitedError);
    // Carried through untouched, because it is what the caller owes `Retry-After`.
    expect(error instanceof RateLimitedError && error.retryAfterSeconds).toBe(120);
    // The point of a limit is to deny the hashing, not to report it afterwards.
    expect(verify).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });

  it.each([
    ['nobody has the address', null, true],
    ['the password is wrong', credentialsFor(), false],
  ])('answers the same way when %s', async (_name, credentials, matches) => {
    const { useCase, verify } = build({ credentials, matches });

    const result = await useCase.execute(COMMAND);

    expect(isErr(result) && result.error).toBeInstanceOf(UnauthenticatedError);
    expect(isErr(result) && result.error.message).toBe('Email or password is incorrect.');
    // Both paths pay for a verification, so the two cannot be told apart by timing.
    expect(verify).toHaveBeenCalledOnce();
  });

  it('verifies against a stand-in hash when the address is unknown', async () => {
    const { useCase, verify } = build({ credentials: null });

    await useCase.execute(COMMAND);

    // `null` is what makes the hasher reach for its absent-account hash; an
    // early return here would be the timing leak this exists to close.
    expect(verify).toHaveBeenCalledWith(null, COMMAND.password);
  });

  it('leaves the counter alone when the password does not match', async () => {
    const { useCase, throttle } = build({ credentials: credentialsFor(), matches: false });

    await useCase.execute(COMMAND);

    expect(throttle.clearSignIn).not.toHaveBeenCalled();
  });
});
