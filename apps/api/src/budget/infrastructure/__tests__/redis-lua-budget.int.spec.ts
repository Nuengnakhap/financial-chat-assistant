import type { AppConfig } from '@fca/config';
import { MicroUsd, UserId, type Reservation } from '@fca/domain';
import fc from 'fast-check';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { delay } from '../../../shared/async/timeouts';
import { testConfig } from '../../../shared/config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { RedisService } from '../../../shared/redis/redis.service';
import { budgetStoreContract } from '../../application/ports/__tests__/budget.store.contract';
import type { UsageLedger } from '../../application/ports/usage-ledger.port';
import { RedisLuaBudgetStore } from '../redis-lua-budget.store';

/**
 * The limit, against a real Redis.
 *
 * A fake cannot hold the property this file exists for: the whole point of the
 * scripts is that they are one step each, and a double that runs them as
 * JavaScript has already lost the interleaving that would break them.
 */

const silent = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));
const ADA = UserId.trusted('9f1b7c2e-0d3a-4f5b-8c6d-7e8f9a0b1c2d');
const GRACE = UserId.trusted('3b0d1a4e-77c9-4a2f-9d61-5f8a2b7c4e10');

/** A dollar, in the same integer micro-USD the rest of the budget path uses. */
const LIMIT_USD = 1;
const usd = (amount: number): MicroUsd => MicroUsd.fromUsd(amount);

let redis: RedisService;
let admin: Redis;

function url(): string {
  const value = process.env['TEST_REDIS_URL'];
  if (value === undefined) throw new Error('TEST_REDIS_URL is not set; global setup did not run');
  return value;
}

/** What the ledger says was spent in the window being read; zero unless a test says so. */
let ledgerTotal = MicroUsd.ZERO;
/** Milliseconds the ledger takes, for the tests about what happens meanwhile. */
let slowLedgerBy = 0;
let failLedgerOnce = false;
const ledger: UsageLedger = {
  spentIn: async () => {
    if (failLedgerOnce) {
      failLedgerOnce = false;
      throw new Error('the ledger is unreachable');
    }
    if (slowLedgerBy > 0) await delay(slowLedgerBy);

    return await Promise.resolve(ledgerTotal);
  },
};

function storeWith(limitUsd = LIMIT_USD, windowSeconds = 3_600): RedisLuaBudgetStore {
  const config: AppConfig = {
    ...testConfig(),
    redis: { url: url() },
    usage: { limitUsd, windowSeconds, pricingPath: null, sendsPerMinute: 6 },
  };

  return new RedisLuaBudgetStore(redis, ledger, config);
}

async function reserved(store: RedisLuaBudgetStore, amount: number): Promise<Reservation> {
  const held = await store.reserve(ADA, usd(amount));
  if (held === null) throw new Error(`reserve of $${String(amount)} was refused`);

  return held;
}

beforeAll(() => {
  const config: AppConfig = { ...testConfig(), redis: { url: url() } };
  redis = new RedisService(config, silent);
  admin = new Redis(url());
});
beforeEach(async () => {
  await admin.flushall();
  ledgerTotal = MicroUsd.ZERO;
  slowLedgerBy = 0;
  failLedgerOnce = false;
});
afterAll(async () => {
  await redis.onModuleDestroy();
  await admin.quit();
});

/**
 * Everything the port promises, asked of the adapter that is actually deployed.
 * The suite is shared with the in-memory implementation beside the port, so a
 * sentence that only holds because of how the Lua happens to be written fails
 * there rather than becoming the contract.
 */
budgetStoreContract('redis lua', () => ({ store: storeWith(), limit: usd(LIMIT_USD) }));

describe('holding a claim on a budget', () => {
  it('grants what fits and refuses what does not', async () => {
    const store = storeWith();

    expect(await store.reserve(ADA, usd(0.6))).not.toBeNull();
    // Not "the total so far is under the limit" but "this one still fits":
    // 0.6 + 0.6 is over a dollar, so the second is refused outright.
    expect(await store.reserve(ADA, usd(0.6))).toBeNull();
  });

  it('leaves the counter untouched when it refuses', async () => {
    const store = storeWith();
    await reserved(store, 0.6);

    await store.reserve(ADA, usd(0.6));

    // A refusal that had already added would ratchet the total upwards every
    // time somebody was turned away.
    expect((await store.read(ADA)).reserved.toUsdNumber()).toBeCloseTo(0.6, 6);
  });

  it('counts what one person spends against theirs alone', async () => {
    const store = storeWith();
    await reserved(store, 0.9);

    expect(await store.reserve(GRACE, usd(0.9))).not.toBeNull();
  });
});

describe('closing the books on a claim', () => {
  it('gives back what was held and charges what was spent', async () => {
    const store = storeWith();
    const claim = await reserved(store, 0.6);

    await store.settle(claim, usd(0.003));

    const state = await store.read(ADA);
    expect(state.reserved.isZero).toBe(true);
    expect(state.spent.toUsdNumber()).toBeCloseTo(0.003, 6);
  });

  it('adds the charge once however many times it is told', async () => {
    // The runner, a stop and the janitor can all reach the same generation.
    const store = storeWith();
    const claim = await reserved(store, 0.6);

    await store.settle(claim, usd(0.003));
    await store.settle(claim, usd(0.003));
    await store.settle(claim, usd(0.003));

    expect((await store.read(ADA)).spent.toUsdNumber()).toBeCloseTo(0.003, 6);
  });

  it('gives back a claim that spent nothing, and charges nothing for it', async () => {
    const store = storeWith();
    const claim = await reserved(store, 0.6);

    await store.release(claim);
    await store.release(claim);

    const state = await store.read(ADA);
    expect(state.reserved.isZero).toBe(true);
    expect(state.spent.isZero).toBe(true);
  });

  it('does nothing for a claim from another window', async () => {
    const store = storeWith();
    const claim = await reserved(store, 0.6);
    const elsewhere: Reservation = { ...claim, windowStart: new Date(0) };

    await store.settle(elsewhere, usd(0.5));

    // The claim it names is not in this window, so this window is unchanged —
    // rather than charged against a claim nobody made in it.
    const state = await store.read(ADA);
    expect(state.spent.isZero).toBe(true);
    expect(state.reserved.toUsdNumber()).toBeCloseTo(0.6, 6);
  });

  it('frees the room it was holding, so the next question fits', async () => {
    const store = storeWith();
    const claim = await reserved(store, 0.9);
    expect(await store.reserve(ADA, usd(0.5))).toBeNull();

    await store.settle(claim, usd(0.01));

    expect(await store.reserve(ADA, usd(0.5))).not.toBeNull();
  });
});

describe('what the window says about itself', () => {
  it('reads as untouched before anybody has spent in it', async () => {
    const state = await storeWith().read(ADA);

    expect(state.spent.isZero).toBe(true);
    expect(state.reserved.isZero).toBe(true);
    expect(state.limit.toUsdNumber()).toBeCloseTo(LIMIT_USD, 6);
  });

  it('says when it resets, on the boundary of a fixed window', async () => {
    const state = await storeWith(LIMIT_USD, 180).read(ADA);
    const resetAt = state.resetAt.getTime();

    // Fixed rather than sliding: a countdown can only be shown for a window
    // that has an end, and a sliding one never does.
    expect(resetAt % 180_000).toBe(0);
    expect(resetAt).toBeGreaterThan(Date.now());
    expect(resetAt - Date.now()).toBeLessThanOrEqual(180_000);
  });

  it('keeps the claim alive past the end of its own window', async () => {
    const store = storeWith(LIMIT_USD, 60);
    const claim = await reserved(store, 0.5);
    const key = `bgt:{${ADA}}:${String(Math.floor(claim.windowStart.getTime() / 1_000))}`;

    // A claim made in the last second of a window still has to be settleable
    // afterwards, or the answer it belongs to is charged to nobody.
    expect(await admin.ttl(key)).toBeGreaterThan(60);
  });
});

describe('the property the whole design exists for', () => {
  it('never lets spent and held together pass the limit, whatever the order', async () => {
    const store = storeWith();

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            amount: fc.integer({ min: 1, max: 250_000 }),
            ending: fc.constantFrom<'settle' | 'release' | 'leave'>('settle', 'release', 'leave'),
            spend: fc.integer({ min: 0, max: 250_000 }),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        async (operations) => {
          await admin.flushall();

          // Fired together rather than in turn: what is being tested is what
          // happens when several arrive at once, which is the case a check
          // followed by a write cannot survive.
          await Promise.all(
            operations.map(async (operation) => {
              const claim = await store.reserve(ADA, MicroUsd.fromMicro(BigInt(operation.amount)));
              if (claim === null || operation.ending === 'leave') return;

              if (operation.ending === 'release') return await store.release(claim);

              return await store.settle(
                claim,
                MicroUsd.fromMicro(BigInt(Math.min(operation.spend, operation.amount))),
              );
            }),
          );

          const state = await store.read(ADA);

          expect(state.spent.plus(state.reserved).isGreaterThan(state.limit)).toBe(false);
          expect(state.spent.isNegative).toBe(false);
          expect(state.reserved.isNegative).toBe(false);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('a counter Redis has forgotten', () => {
  it('reads the window back from the ledger the first time anybody asks', async () => {
    // A restart with no AOF, or an eviction that should not have happened: from
    // here a forgotten window and a fresh one look exactly alike, so the ledger
    // is what tells them apart.
    ledgerTotal = usd(0.7);

    const state = await storeWith().read(ADA);

    expect(state.spent.toUsdNumber()).toBeCloseTo(0.7, 6);
  });

  it('enforces the limit against what it read back', async () => {
    ledgerTotal = usd(0.99);

    // Otherwise a restart is how somebody gets their window back.
    expect(await storeWith().reserve(ADA, usd(0.5))).toBeNull();
  });

  it('reads it back once, not once per request', async () => {
    let asked = 0;
    ledgerTotal = usd(0.2);
    const counting: UsageLedger = {
      spentIn: async () => {
        asked += 1;
        return await Promise.resolve(ledgerTotal);
      },
    };
    const store = new RedisLuaBudgetStore(redis, counting, {
      ...testConfig(),
      redis: { url: url() },
      usage: { limitUsd: LIMIT_USD, windowSeconds: 3_600, pricingPath: null, sendsPerMinute: 6 },
    });

    await store.read(ADA);
    await store.read(ADA);
    await store.reserve(ADA, usd(0.1));

    expect(asked).toBe(1);
  });

  it('does not grant a hold against a window whose history has not come back yet', async () => {
    // The case this whole path exists for is several requests arriving at once
    // after Redis has forgotten a window. Whoever loses the race to rebuild it
    // must not go on to judge a hold against a counter that still reads zero —
    // the total would then be the ledger plus a hold nobody counted.
    const store = storeWith();
    ledgerTotal = usd(0.9);
    slowLedgerBy = 50;

    const [, held] = await Promise.all([store.read(ADA), store.reserve(ADA, usd(0.5))]);

    expect(held).toBeNull();
    expect((await store.read(ADA)).spent.toUsdNumber()).toBeCloseTo(0.9, 6);
  });

  it('tries again after a ledger it could not read, rather than giving up on the window', async () => {
    // A marker set before the read means one bad moment turns into an hour of
    // enforcing the limit against a window with no history in it.
    const store = storeWith();
    ledgerTotal = usd(0.9);
    failLedgerOnce = true;

    await expect(store.read(ADA)).rejects.toThrow(/ledger is unreachable/);

    expect((await store.read(ADA)).spent.toUsdNumber()).toBeCloseTo(0.9, 6);
  });

  it('does not lose a claim settled while the ledger was being read', async () => {
    // Both are increments, so a settle that landed first is added to rather
    // than overwritten — assigning the ledger total would throw it away.
    const store = storeWith();
    const claim = await reserved(store, 0.3);
    await store.settle(claim, usd(0.05));
    await admin.hdel(
      `bgt:{${ADA}}:${String(Math.floor(claim.windowStart.getTime() / 1_000))}`,
      'from_ledger',
    );
    ledgerTotal = usd(0.4);

    const state = await store.read(ADA);

    expect(state.spent.toUsdNumber()).toBeCloseTo(0.45, 6);
  });
});
