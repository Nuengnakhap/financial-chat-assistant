import type { AppConfig } from '@fca/config';
import {
  ClientMessageId,
  Ok,
  ReservationId,
  type ConversationId,
  type Reservation,
  type UserId,
} from '@fca/domain';
import { eq } from 'drizzle-orm';
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
import { conversations, messages, outboxEvents } from '../../shared/persistence/schema';
import type { GenerationBudget } from '../application/ports/budget.port';
import { StartGenerationUseCase } from '../application/use-cases/start-generation.use-case';

/**
 * Sending against a real PostgreSQL, through the real `UnitOfWork`. Three of the
 * rules this command rests on live only in the database — the partial unique
 * index that allows one generation per conversation, the idempotency constraint
 * on the client id, and the fact that the outbox row and the message rows commit
 * together — and a fake can answer for none of them.
 */
function integrationConfig(): AppConfig {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined) throw new Error('TEST_DATABASE_URL is not set; global setup did not run');

  const base = testConfig();
  return { ...base, database: { ...base.database, url } };
}

/**
 * Always granted here: what this file is about is the rows, and refusing is
 * covered where the arithmetic is. The claim it hands back is the one the row
 * has to come back carrying.
 */
const RESERVATION: Reservation = {
  userId: ReservationId.trusted('00000000-0000-4000-8000-000000000000') as unknown as UserId,
  id: ReservationId.trusted('7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'),
  windowStart: new Date('2026-09-02T14:00:00.000Z'),
};
const released: Reservation[] = [];
const budget: GenerationBudget = {
  reserve: async () => await Promise.resolve(Ok({ ...RESERVATION, userId: ada })),
  release: async (reservation) => {
    released.push(reservation);
    await Promise.resolve();
  },
};

let harness: Harness;
let database: DatabaseService;
let start: StartGenerationUseCase;
let ada: UserId;
let room: ConversationId;

beforeAll(async () => {
  harness = await startHarness();
  database = new DatabaseService(integrationConfig());
  start = new StartGenerationUseCase(new DrizzleUnitOfWork(database), budget);
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
  start.execute({ userId: ada }, { conversationId: room, clientMessageId, content });

const storedMessages = () => harness.db.select().from(messages).orderBy(messages.seq);

/** Frees the conversation for the next question, the way a finished runner does. */
const finishGenerating = async (): Promise<void> => {
  await harness.db
    .update(messages)
    .set({ status: 'stopped' })
    .where(eq(messages.status, 'generating'));
};

describe('one send', () => {
  it('leaves the question, the row for its answer and the event as one commit', async () => {
    const started = await send('What was the revenue of Apple in 2024?');

    const rows = await storedMessages();
    expect(rows.map((row) => [row.role, row.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'generating'],
    ]);
    expect(started.ok && started.value.assistantMessageId).toBe(rows[1]?.id);

    const [event] = await harness.db.select().from(outboxEvents);
    expect(event?.type).toBe('generation.requested');
    // The aggregate is the answer, so a redelivered job names the row it has to
    // claim rather than the conversation it belongs to.
    expect(event?.aggregateId).toBe(rows[1]?.id);
    expect(event?.publishedAt).toBeNull();
  });
});

describe('a second question arriving while the first is being answered', () => {
  it('is refused, and leaves nothing of itself behind', async () => {
    await send('first');

    const second = await send('second');

    expect(!second.ok && second.error.code).toBe('conflict');
    // The whole transaction unwound: no orphan question, and no second event.
    expect((await storedMessages()).map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(await harness.db.select().from(outboxEvents)).toHaveLength(1);
  });

  it('is allowed again once the answer is no longer being written', async () => {
    await send('first');
    await finishGenerating();

    expect((await send('second')).ok).toBe(true);
  });

  it('lets exactly one of a hundred simultaneous sends through', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_unused, index) => send(`message ${String(index)}`)),
    );

    // Every one of them is answered — the loser hears `conflict`, not a driver
    // error and not a rejected promise, which is the difference between a rule
    // and a crash.
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.code === 'conflict')).toHaveLength(
      99,
    );
    expect(await storedMessages()).toHaveLength(2);
  });
});

describe('the same send arriving twice', () => {
  it('attaches to the answer already being written, whichever request wrote it', async () => {
    const clientMessageId = newClientId();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => send('hello', clientMessageId)),
    );

    const started = results.map((result) => (result.ok ? result.value : null));
    expect(started.every((value) => value !== null)).toBe(true);
    // One of them started it and the rest recognised it; which one started it is
    // not something a client can or should depend on.
    expect(started.filter((value) => value?.resumed === false)).toHaveLength(1);
    expect(new Set(started.map((value) => value?.assistantMessageId)).size).toBe(1);
    expect(await storedMessages()).toHaveLength(2);
  });

  it('answers a plain retry with the same answer id', async () => {
    const clientMessageId = newClientId();

    const first = await send('hello', clientMessageId);
    const again = await send('hello', clientMessageId);

    expect(first.ok && first.value.resumed).toBe(false);
    expect(again.ok && again.value.resumed).toBe(true);
    expect(again.ok && again.value.assistantMessageId).toBe(
      first.ok ? first.value.assistantMessageId : null,
    );
  });

  it('still finds the answer after the generation has finished', async () => {
    // The link is the position, not the status: a client that retries a send
    // long after the answer was written gets that answer, not a new one.
    const clientMessageId = newClientId();
    const first = await send('hello', clientMessageId);
    await finishGenerating();

    const again = await send('hello', clientMessageId);

    expect(again.ok && again.value.assistantMessageId).toBe(
      first.ok ? first.value.assistantMessageId : null,
    );
  });
});

describe('the first message', () => {
  it('names the conversation, and the second leaves the name alone', async () => {
    await send('What was the revenue of Apple in 2024?');
    await finishGenerating();
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

    const refused = await start.execute(
      { userId: grace },
      { conversationId: room, clientMessageId: newClientId(), content: 'hello' },
    );

    expect(!refused.ok && refused.error.code).toBe('not_found');
    expect(await storedMessages()).toEqual([]);
    expect(await harness.db.select().from(outboxEvents)).toEqual([]);
  });
});
