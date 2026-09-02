import type { AppConfig } from '@fca/config';
import type { ConversationId, UserId } from '@fca/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testConfig } from '../../shared/config/__tests__/test-config';
import {
  insertConversation,
  insertUser,
  startHarness,
  type Harness,
} from '../../shared/persistence/__tests__/harness';
import { DatabaseService } from '../../shared/persistence/database.service';
import { DrizzleUnitOfWork } from '../../shared/persistence/drizzle-unit-of-work';
import type { UnitOfWork } from '../../shared/persistence/unit-of-work';

/**
 * Appending under contention, against a real PostgreSQL and inside the real
 * `UnitOfWork` — which is the part a fake cannot answer for. A unique violation
 * aborts the whole transaction it fires in, so whether the sequence retry
 * survives depends entirely on where the transaction boundary is.
 *
 * Driven at the repository rather than through a use case on purpose: the
 * command above it allows one generation per conversation, so no send of its
 * own can produce this much contention, and the retry that absorbs it would
 * stop being covered by anything the day it broke.
 */
function integrationConfig(): AppConfig {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined) throw new Error('TEST_DATABASE_URL is not set; global setup did not run');

  const base = testConfig();
  return { ...base, database: { ...base.database, url } };
}

let harness: Harness;
let database: DatabaseService;
let uow: UnitOfWork;
let ada: UserId;
let room: ConversationId;

beforeAll(async () => {
  harness = await startHarness();
  database = new DatabaseService(integrationConfig());
  uow = new DrizzleUnitOfWork(database);
}, 120_000);

afterAll(async () => {
  await database.onModuleDestroy();
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  ada = await insertUser(harness.db, 'ada@example.com');
  room = await insertConversation(harness.db, ada);
});

const append = (content: string) =>
  uow.run(
    async (ctx) =>
      await ctx.messages.append({
        conversationId: room,
        clientMessageId: null,
        role: 'user',
        parts: [{ kind: 'text', text: content }],
        status: 'complete',
      }),
  );

const storedSeqs = async (): Promise<readonly number[]> => {
  const rows = await harness.db.query.messages.findMany();

  return rows.map((row) => row.seq).sort((a, b) => a - b);
};

describe('many writers at once in one conversation', () => {
  it.each([50, 100])('loses none of %i simultaneous appends', async (count) => {
    const results = await Promise.allSettled(
      Array.from({ length: count }, (_unused, index) => append(`message ${String(index)}`)),
    );

    // Counting rejections is the whole test. Measured before the retry had any
    // spread in it: a hundred at once lost seven to ten, and every stored
    // sequence was still gapless — so a test that checked only the numbers
    // passed while the work went missing.
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected.map((result) => String(result.reason))).toEqual([]);

    expect(await storedSeqs()).toEqual(Array.from({ length: count }, (_u, index) => index + 1));
  });
});
