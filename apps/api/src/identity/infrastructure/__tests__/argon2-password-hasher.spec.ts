import { describe, expect, it, vi } from 'vitest';

import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { ABSENT_ACCOUNT_HASH, Argon2PasswordHasher } from '../argon2-password-hasher';

const silent = (): AppLogger => new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

const hasher = new Argon2PasswordHasher(silent());
const PASSWORD = 'correct horse battery staple';

/** The `$argon2id$v=19$m=...,t=...,p=...$` part, which is what decides the cost. */
const parametersOf = (encoded: string): string => encoded.split('$').slice(0, 4).join('$');

describe('hashing a password', () => {
  it('produces argon2id at the parameters we chose, recorded in the hash itself', async () => {
    // The encoded prefix is what lets an old row keep verifying after the
    // parameters change, so it is part of the contract rather than a detail.
    expect(await hasher.hash(PASSWORD)).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
  });

  it('gives two people with the same password different hashes', async () => {
    const [first, second] = await Promise.all([hasher.hash(PASSWORD), hasher.hash(PASSWORD)]);

    // A shared salt would let one cracked hash reveal every account using it.
    expect(first).not.toBe(second);
  });
});

describe('verifying', () => {
  it('accepts the password it was given', async () => {
    expect(await hasher.verify(await hasher.hash(PASSWORD), PASSWORD)).toBe(true);
  });

  it('rejects a password that only differs in case', async () => {
    expect(await hasher.verify(await hasher.hash(PASSWORD), PASSWORD.toUpperCase())).toBe(false);
  });

  it('still accepts a hash made at the parameters we used to use', async () => {
    // A real hash of PASSWORD at m=19456,t=2,p=1 — the older OWASP baseline.
    // Raising the cost must not lock out everyone who signed up before it rose.
    const older =
      '$argon2id$v=19$m=19456,t=2,p=1$o5rvuOky9UZbVxpjRSbj/g$S4RIvAFgq8aWI0ZwtjDuWSVubgKLTvQRs3crq0dmjWg';

    await expect(hasher.verify(older, PASSWORD)).resolves.toBe(true);
    await expect(hasher.verify(older, 'a different password')).resolves.toBe(false);
  });
});

describe('a stored hash argon2 cannot read', () => {
  it('is a failed match, not an error the caller has to handle', async () => {
    await expect(hasher.verify('not-an-argon2-hash', PASSWORD)).resolves.toBe(false);
  });

  it('is reported, because one bad row and a broken column look identical from outside', async () => {
    const logger = silent();
    const warn = vi.spyOn(logger, 'warn');

    await new Argon2PasswordHasher(logger).verify('not-an-argon2-hash', PASSWORD);

    expect(warn).toHaveBeenCalledWith(
      'stored password hash was rejected by argon2',
      expect.objectContaining({ scope: 'Argon2PasswordHasher' }),
    );
  });

  it('is reported without the hash or the password in the line', async () => {
    const logger = silent();
    const warn = vi.spyOn(logger, 'warn');

    await new Argon2PasswordHasher(logger).verify('not-an-argon2-hash', PASSWORD);

    expect(JSON.stringify(warn.mock.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not-an-argon2-hash');
  });
});

describe('when no account matched the address', () => {
  it('answers false', async () => {
    expect(await hasher.verify(null, PASSWORD)).toBe(false);
  });

  it('still spends the time a real verification costs', async () => {
    // The point of the null case: an early return here would answer in
    // microseconds and tell an attacker which addresses have accounts.
    const started = performance.now();
    await hasher.verify(null, PASSWORD);
    const elapsed = performance.now() - started;

    // A real verify measures ~33ms on this configuration; a skipped one is ~0.
    expect(elapsed).toBeGreaterThan(10);
  });

  it('costs the same as a real one, whatever the parameters become', async () => {
    // Timing parity is decided by the parameters baked into each hash, not by
    // the ones we configure now. Raising the cost without reissuing this
    // constant would reopen the gap it exists to close, and the timing test
    // above would not notice, because both are still well over its floor.
    expect(parametersOf(ABSENT_ACCOUNT_HASH)).toBe(parametersOf(await hasher.hash('anything')));
  });
});
