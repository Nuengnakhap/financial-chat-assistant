import type { AppConfig } from '@fca/config';
import type { UserId } from '@fca/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import {
  insertUser,
  startHarness,
  type Harness,
} from '../../../shared/persistence/__tests__/harness';
import { DatabaseService } from '../../../shared/persistence/database.service';
import { usageEvents } from '../../../shared/persistence/schema';
import { DrizzleUsageLedger } from '../drizzle-usage-ledger';

/**
 * The record a window is read back from after Redis has been restarted.
 *
 * Against a real database because the two things worth checking are both the
 * database's: that summing `bigint` costs does not go through a JavaScript
 * number on the way, and that the index this query was written for is the shape
 * the query asks for.
 */

function integrationConfig(): AppConfig {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined) throw new Error('TEST_DATABASE_URL is not set; global setup did not run');

  const base = testConfig();
  return { ...base, database: { ...base.database, url } };
}

const WINDOW = new Date('2026-09-02T14:00:00.000Z');
const EARLIER = new Date('2026-09-02T13:00:00.000Z');

let harness: Harness;
let database: DatabaseService;
let ledger: DrizzleUsageLedger;
let ada: UserId;
let grace: UserId;

beforeAll(async () => {
  harness = await startHarness();
  database = new DatabaseService(integrationConfig());
  ledger = new DrizzleUsageLedger(database);
}, 120_000);

afterAll(async () => {
  await database.onModuleDestroy();
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  ada = await insertUser(harness.db, 'ada@example.com');
  grace = await insertUser(harness.db, 'grace@example.com');
});

async function charge(userId: UserId, windowStart: Date, costMicroUsd: bigint): Promise<void> {
  await harness.db.insert(usageEvents).values({
    userId,
    messageId: crypto.randomUUID(),
    windowStart,
    model: 'gpt-5.6-luna',
    inputTokens: 1_800,
    cachedInputTokens: 0,
    outputTokens: 90,
    costMicroUsd,
  });
}

describe('what a window came to', () => {
  it('adds up every charge in it', async () => {
    await charge(ada, WINDOW, 1_890n);
    await charge(ada, WINDOW, 2_110n);

    expect((await ledger.spentIn(ada, WINDOW)).micro).toBe(4_000n);
  });

  it('counts one person and one window, and nothing beside them', async () => {
    await charge(ada, WINDOW, 1_000n);
    await charge(ada, EARLIER, 500_000n);
    await charge(grace, WINDOW, 900_000n);

    expect((await ledger.spentIn(ada, WINDOW)).micro).toBe(1_000n);
  });

  it('reads a window nobody spent in as nothing', async () => {
    expect((await ledger.spentIn(ada, WINDOW)).isZero).toBe(true);
  });

  it('stays exact past what a double could hold', async () => {
    // `sum()` over `bigint` is `numeric`, and a driver handing that back as a
    // JavaScript number would round away the last digits — the very ones this
    // column is an integer to keep.
    await charge(ada, WINDOW, 9_007_199_254_740_993n);
    await charge(ada, WINDOW, 1n);

    expect((await ledger.spentIn(ada, WINDOW)).micro).toBe(9_007_199_254_740_994n);
  });
});
