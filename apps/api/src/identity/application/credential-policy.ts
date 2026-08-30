import { Err, Ok, UnauthenticatedError, type RateLimitedError, type Result } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { AUTH_THROTTLE, type AuthThrottle } from './ports/auth-throttle';
import { PASSWORD_HASHER, type PasswordHasher } from './ports/password-hasher';
import type { Credentials, StoredUser } from './ports/user.repository';

/**
 * One sentence for every way this fails, because "no such account" and "wrong
 * password" are the same answer to anyone who should not be told them apart.
 */
const REJECTED = 'Email or password is incorrect.';

export type SignInError = UnauthenticatedError | RateLimitedError;

/**
 * Everything about a credential that has to be true no matter which use case is
 * asking: attempts are counted before the expensive work, hashing happens one
 * way, and every rejection costs the same. Kept together so none of the three
 * can be forgotten on its own.
 */
@Injectable()
export class CredentialPolicy {
  constructor(
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(AUTH_THROTTLE) private readonly throttle: AuthThrottle,
  ) {}

  /**
   * Called before the account is even looked up, so a flood is turned away
   * ahead of the hashing it was trying to buy.
   */
  async beginSignIn(email: string, ipHash: string): Promise<Result<void, RateLimitedError>> {
    return await this.throttle.recordSignIn(email, ipHash);
  }

  /**
   * Registering answers "is this address taken?", which is the same question
   * signing in answers — so it has to cost something too, or the throttle on
   * the other door is decoration.
   */
  async beginRegistration(ipHash: string): Promise<Result<void, RateLimitedError>> {
    return await this.throttle.recordRegistration(ipHash);
  }

  async hash(password: string): Promise<string> {
    return await this.passwords.hash(password);
  }

  /**
   * `null` credentials still cost a full verification, against a hash carrying
   * the same parameters — an early return is what makes an address nobody has
   * answer in a millisecond and a real one in thirty.
   */
  async verify(
    credentials: Credentials | null,
    attempt: { readonly email: string; readonly password: string },
  ): Promise<Result<StoredUser, UnauthenticatedError>> {
    const matched = await this.passwords.verify(
      credentials?.passwordHash ?? null,
      attempt.password,
    );
    if (credentials === null || !matched) return Err(new UnauthenticatedError(REJECTED));

    await this.throttle.clearSignIn(attempt.email);
    return Ok(credentials.user);
  }
}
