import type { AppConfig } from '@fca/config';
import { ClientMessageId, type ConversationId, type UserId } from '@fca/domain';
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
import { conversations } from '../../shared/persistence/schema';
import { AppendUserMessageUseCase } from '../application/use-cases/append-user-message.use-case';

/**
 * Concurrency against a real PostgreSQL, through the real `UnitOfWork` — which
 * is the part a fake cannot answer for. A unique violation aborts the whole
 * transaction it fires in, so whether the sequence retry survives depends
 * entirely on where the transaction boundary is.
 */
function integrationConfig(): AppConfig {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined) throw new Error('TEST_DATABASE_URL is not set; global setup did not run');

  const base = testConfig();
  return { ...base, database: { ...base.database, url } };
}

let harness: Harness;
let database: DatabaseService;
let append: AppendUserMessageUseCase;
let ada: UserId;
let room: ConversationId;

beforeAll(async () => {
  harness = await startHarness();
  database = new DatabaseService(integrationConfig());
  append = new AppendUserMessageUseCase(new DrizzleUnitOfWork(database));
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

const newClientId = (): ClientMessageId => ClientMessageId.trusted(crypto.randomUUID());

const send = (content: string, clientMessageId = newClientId()) =>
  append.execute({ userId: ada }, { conversationId: room, clientMessageId, content });

const storedSeqs = async (): Promise<readonly number[]> => {
  const rows = await harness.db.query.messages.findMany();

  return rows.map((row) => row.seq).sort((a, b) => a - b);
};

describe('many people sending at once', () => {
  it.each([50, 100])('loses none of %i simultaneous sends', async (count) => {
    const results = await Promise.allSettled(
      Array.from({ length: count }, (_unused, index) => send(`message ${String(index)}`)),
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

describe('the same send arriving twice', () => {
  it('reaches one message, whichever of them gets there first', async () => {
    const clientMessageId = newClientId();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => send('hello', clientMessageId)),
    );

    const stored = results.map((result) => (result.ok ? result.value : null));
    expect(stored.every((message) => message !== null)).toBe(true);
    // One of them wrote it and the rest recognised it; which one wrote it is
    // not something a client can or should depend on.
    expect(stored.filter((message) => message?.created === true)).toHaveLength(1);
    expect(new Set(stored.map((message) => message?.message.id)).size).toBe(1);
    expect(await storedSeqs()).toEqual([1]);
  });

  it('answers a plain retry with the message it already wrote', async () => {
    const clientMessageId = newClientId();

    const first = await send('hello', clientMessageId);
    const again = await send('hello', clientMessageId);

    expect(first.ok && first.value.created).toBe(true);
    expect(again.ok && again.value.created).toBe(false);
    expect(again.ok && again.value.message.id).toBe(first.ok ? first.value.message.id : null);
  });
});

describe('the first message', () => {
  it('names the conversation, and the second leaves the name alone', async () => {
    await send('What was the revenue of Apple in 2024?');
    await send('and Microsoft?');

    const [row] = await harness.db.select().from(conversations);
    expect(row?.title).toBe('What was the revenue of Apple in 2024?');
  });

  it('brings the conversation back to the top of the list', async () => {
    const before = (await harness.db.select().from(conversations))[0]?.updatedAt;

    await send('hello');

    const after = (await harness.db.select().from(conversations))[0]?.updatedAt;
    expect(after?.getTime() ?? 0).toBeGreaterThan(before?.getTime() ?? 0);
  });

  it('fits the column even when the message is as long as the contract allows', async () => {
    // 4,000 characters is the ceiling on a message; the title column stops at
    // 120, and a check constraint is what would reject an over-long one.
    await send('word '.repeat(800));

    const [row] = await harness.db.select().from(conversations);
    expect(row?.title.length).toBeLessThanOrEqual(120);
    expect(row?.title.endsWith('…')).toBe(true);
  });

  it('leaves the name alone when the message is only whitespace', async () => {
    await send('   \n  ');

    const [row] = await harness.db.select().from(conversations);
    expect(row?.title).toBe('New chat');
  });
});

describe('a conversation that is not the sender to write in', () => {
  it('answers not found rather than storing anything', async () => {
    const grace = await insertUser(harness.db, 'grace@example.com');

    const refused = await append.execute(
      { userId: grace },
      { conversationId: room, clientMessageId: newClientId(), content: 'hello' },
    );

    expect(!refused.ok && refused.error.code).toBe('not_found');
    expect(await storedSeqs()).toEqual([]);
  });
});
