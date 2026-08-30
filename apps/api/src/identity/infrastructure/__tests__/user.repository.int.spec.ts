import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from '../../../shared/persistence/__tests__/harness';
import { DrizzleUserRepository } from '../drizzle-user.repository';

let h: Harness;
let repo: DrizzleUserRepository;

beforeAll(async () => {
  h = await startHarness();
  repo = new DrizzleUserRepository(h.db);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

const ADA = { email: 'Ada@example.com', displayName: 'Ada', passwordHash: 'argon2-hash' };

describe('registering an address', () => {
  it('stores it and hands back the view, without the hash', async () => {
    const created = await repo.create(ADA);

    expect(created?.email).toBe('Ada@example.com');
    expect(JSON.stringify(created)).not.toContain('argon2-hash');
  });

  it('reports a taken address instead of failing', async () => {
    await repo.create(ADA);

    expect(await repo.create({ ...ADA, email: 'ADA@EXAMPLE.com' })).toBeNull();
  });

  it('leaves the transaction usable after a taken address', async () => {
    await repo.create(ADA);

    await h.db.transaction(async (tx) => {
      const scoped = new DrizzleUserRepository(tx);
      expect(await scoped.create(ADA)).toBeNull();

      // A rejected INSERT would have aborted the transaction and made every
      // later statement fail — which is why this uses ON CONFLICT DO NOTHING
      // rather than catching the violation.
      expect(await scoped.create({ ...ADA, email: 'grace@example.com' })).not.toBeNull();
    });
  });
});

describe('looking up credentials', () => {
  it('finds the account however the address was typed', async () => {
    await repo.create(ADA);

    const found = await repo.findCredentialsByEmail('  ADA@Example.COM  ');

    expect(found?.user.email).toBe('Ada@example.com');
    expect(found?.passwordHash).toBe('argon2-hash');
  });

  it('finds nothing for an address nobody registered', async () => {
    expect(await repo.findCredentialsByEmail('nobody@example.com')).toBeNull();
  });
});
