import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

import { AppLogger, asError } from '../../shared/observability/app-logger';
import type { PasswordHasher } from '../application/ports/password-hasher';

/**
 * OWASP's argon2id baseline. Measured here at ~31ms to hash and ~33ms to verify,
 * using 64 MiB — the memory is what makes a GPU farm expensive, and the cost is
 * paid once per sign-in rather than per request.
 *
 * Changing any of these changes every hash the parameters produce. Existing
 * rows keep working because the encoded hash carries the parameters it was made
 * with; only new hashes use the values here.
 */
const OPTIONS = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  // `Algorithm.Argon2id`, written as its value: `isolatedModules` forbids
  // importing an ambient const enum out of a declaration file.
  algorithm: 2,
} as const;

/**
 * A hash of a password nobody has. Verifying against it must cost the same as
 * verifying a real one, which is why its parameters have to match `OPTIONS` —
 * a test compares the two rather than trusting whoever changes them next.
 */
export const ABSENT_ACCOUNT_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$JQpp9XA2LZZRdhhEVQ7kGg$8186gjE2VUIIdjsWvO5kiIE9YCsIfd6g5zBEBjeNLTk';

/**
 * Async on purpose: the synchronous API blocks the event loop for the whole
 * hash — measured at 286ms for eight in a row, against 73ms of worst-case lag
 * for the same eight through this one.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly logger: AppLogger) {}

  async hash(password: string): Promise<string> {
    return await hash(password, OPTIONS);
  }

  async verify(storedHash: string | null, password: string): Promise<boolean> {
    const candidate = storedHash ?? ABSENT_ACCOUNT_HASH;
    try {
      const matched = await verify(candidate, password);
      return storedHash === null ? false : matched;
    } catch (error) {
      // A stored hash that argon2 cannot read is corrupt, not a match. Failing
      // closed keeps a damaged row from becoming a way in — and saying so is
      // what separates "one bad row" from "nobody can sign in", which look the
      // same from outside and have entirely different fixes.
      this.logger.warn('stored password hash was rejected by argon2', {
        scope: 'Argon2PasswordHasher',
        err: asError(error),
      });
      return false;
    }
  }
}
