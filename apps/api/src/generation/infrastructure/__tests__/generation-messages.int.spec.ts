import type { AppConfig } from '@fca/config';
import { MessageId, MicroUsd, type ConversationId, type UserId } from '@fca/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import {
  insertConversation,
  insertUser,
  startHarness,
  type Harness,
} from '../../../shared/persistence/__tests__/harness';
import { DatabaseService } from '../../../shared/persistence/database.service';
import { messages, usageEvents } from '../../../shared/persistence/schema';
import type { Answer } from '../../application/ports/generation-messages.port';
import { DrizzleGenerationMessages } from '../drizzle-generation-messages';

/**
 * The generation context's own reads, against real rows. What is being checked
 * is mostly what happens when the row is not what the happy path assumes — an id
 * naming nothing, a placeholder with no question in front of it, a turn that
 * says nothing — because those are the readings a fake would simply agree with.
 */

function integrationConfig(): AppConfig {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined) throw new Error('TEST_DATABASE_URL is not set; global setup did not run');

  const base = testConfig();
  return { ...base, database: { ...base.database, url } };
}

const NOWHERE = MessageId.trusted('00000000-0000-4000-8000-000000000000');

let harness: Harness;
let database: DatabaseService;
let store: DrizzleGenerationMessages;
let ada: UserId;
let room: ConversationId;

beforeAll(async () => {
  harness = await startHarness();
  database = new DatabaseService(integrationConfig());
  store = new DrizzleGenerationMessages(database);
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

interface Written {
  readonly role: 'user' | 'assistant';
  readonly parts: readonly unknown[];
  readonly status?: 'generating' | 'complete' | 'stopped' | 'error';
  readonly createdAt?: Date;
}

/**
 * A finished assistant message always carries a report — the database refuses
 * one that does not, which is the no-hallucination guarantee in the one place
 * application code cannot bypass. The fixture obeys it rather than working
 * around it.
 */
const PASSED = { verdict: 'pass', checkedClaims: [], violations: [] };

/** Writes a conversation, oldest first, and answers with the last row. */
async function write(...turns: Written[]): Promise<Answer> {
  let last: string | undefined;
  for (const [index, turn] of turns.entries()) {
    // eslint-disable-next-line no-await-in-loop -- each row's seq depends on the one before it
    const [row] = await harness.db
      .insert(messages)
      .values({
        conversationId: room,
        role: turn.role,
        parts: turn.parts,
        status: turn.status ?? 'complete',
        verification:
          turn.role === 'assistant' && (turn.status ?? 'complete') === 'complete' ? PASSED : null,
        seq: index + 1,
        ...(turn.createdAt === undefined ? {} : { createdAt: turn.createdAt }),
      })
      .returning({ id: messages.id });
    last = row?.id;
  }

  const answer = await store.find(MessageId.trusted(last ?? ''));
  if (answer === null) throw new Error('nothing was written');

  return answer;
}

const said = (text: string) => [{ kind: 'text', text }];

describe('finding the row an answer goes in', () => {
  it('carries the owner, which comes from the conversation and not the message', async () => {
    const answer = await write({ role: 'user', parts: said('hello') });

    expect(answer.ownerId).toBe(ada);
  });

  it('answers with nothing for an id that names nothing', async () => {
    expect(await store.find(NOWHERE)).toBeNull();
    expect(await store.view(NOWHERE)).toBeNull();
  });
});

describe('reading the question an answer is for', () => {
  it('takes the turn before it, and everything before that as history', async () => {
    const answer = await write(
      { role: 'user', parts: said('first') },
      { role: 'assistant', parts: said('an answer') },
      { role: 'user', parts: said('and Microsoft?') },
      { role: 'assistant', parts: [], status: 'generating' },
    );

    expect(await store.questionFor(answer)).toEqual({
      text: 'and Microsoft?',
      history: [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'an answer' },
      ],
    });
  });

  it('leaves out a turn that said nothing', async () => {
    // An answer that failed before writing anything, or one that is nothing but
    // tool calls: an empty message is refused outright by some providers.
    const answer = await write(
      { role: 'user', parts: said('first') },
      { role: 'assistant', parts: [], status: 'error' },
      { role: 'user', parts: said('again?') },
      { role: 'assistant', parts: [], status: 'generating' },
    );

    expect((await store.questionFor(answer))?.history).toEqual([{ role: 'user', text: 'first' }]);
  });

  it('answers with nothing when the row before it is not a question', async () => {
    const answer = await write(
      { role: 'assistant', parts: said('unprompted') },
      { role: 'assistant', parts: [], status: 'generating' },
    );

    expect(await store.questionFor(answer)).toBeNull();
  });

  it('answers with nothing for a placeholder with nothing in front of it at all', async () => {
    const answer = await write({ role: 'assistant', parts: [], status: 'generating' });

    expect(await store.questionFor(answer)).toBeNull();
  });

  it('reads a turn whose parts are not parts as having said nothing', async () => {
    // `parts` is `jsonb`, so its shape is a claim rather than something the row
    // can prove, and half a message is worse than none.
    const answer = await write(
      { role: 'user', parts: said('first') },
      { role: 'assistant', parts: [{ kind: 'nonsense' }] },
      { role: 'user', parts: said('again?') },
      { role: 'assistant', parts: [], status: 'generating' },
    );

    expect((await store.questionFor(answer))?.history).toEqual([{ role: 'user', text: 'first' }]);
  });
});

describe('listing the ones nobody is writing any more', () => {
  it('takes only rows that are generating, oldest first', async () => {
    const old = new Date('2026-09-02T10:00:00.000Z');
    const older = new Date('2026-09-02T09:00:00.000Z');
    await write(
      { role: 'user', parts: said('q'), createdAt: older },
      { role: 'assistant', parts: [], status: 'generating', createdAt: older },
    );
    await harness.db.insert(messages).values({
      conversationId: await insertConversation(harness.db, ada),
      role: 'assistant',
      parts: [],
      status: 'generating',
      seq: 1,
      createdAt: old,
    });

    const abandoned = await store.listAbandoned(new Date('2026-09-02T11:00:00.000Z'));

    expect(abandoned.map((answer) => answer.startedAt)).toEqual([older, old]);
  });

  it('leaves alone anything younger than the cutoff', async () => {
    await write(
      { role: 'user', parts: said('q') },
      { role: 'assistant', parts: [], status: 'generating' },
    );

    expect(await store.listAbandoned(new Date('2020-01-01T00:00:00.000Z'))).toEqual([]);
  });
});

describe('ending a generation', () => {
  it('stores the report and answers with the message a client will read', async () => {
    const answer = await write(
      { role: 'user', parts: said('q') },
      { role: 'assistant', parts: [], status: 'generating' },
    );

    const stored = await store.finish({
      messageId: answer.id,
      status: 'complete',
      parts: [{ kind: 'text', text: 'Apple earned $391.0B' }],
      verification: { verdict: 'pass', checkedClaims: [], violations: [] },
      model: 'a-model',
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 20,
      cost: MicroUsd.fromMicro(26n),
      charge: null,
    });

    // The pairing the database's own CHECK constraint holds, read back through
    // the view's refinement, which insists on the same thing.
    expect(stored?.status).toBe('complete');
    expect(stored?.verification?.verdict).toBe('pass');
    expect(stored?.parts).toEqual([{ kind: 'text', text: 'Apple earned $391.0B' }]);
  });
});

describe('the charge that goes with an answer', () => {
  const WINDOW = new Date('2026-09-02T14:00:00.000Z');

  const finishWith = async (answer: Answer, charged: boolean) =>
    await store.finish({
      messageId: answer.id,
      status: 'complete',
      parts: [{ kind: 'text', text: 'Apple earned $391.0B' }],
      verification: { verdict: 'pass', checkedClaims: [], violations: [] },
      model: 'gpt-5.6-luna',
      inputTokens: 1_800,
      cachedInputTokens: 1_536,
      outputTokens: 90,
      cost: MicroUsd.fromMicro(1_890n),
      charge: charged ? { userId: ada, windowStart: WINDOW } : null,
    });

  const ledgerRows = async () => await harness.db.select().from(usageEvents);

  it('is written with the row rather than after it', async () => {
    const answer = await write(
      { role: 'user', parts: said('q') },
      { role: 'assistant', parts: [], status: 'generating' },
    );

    await finishWith(answer, true);

    // One transaction: an answer stored without its charge is a generation
    // somebody got for nothing, and a charge with no answer is money taken for
    // one that never happened.
    const [entry] = await ledgerRows();
    expect(entry).toMatchObject({
      userId: ada,
      messageId: answer.id,
      model: 'gpt-5.6-luna',
      inputTokens: 1_800,
      cachedInputTokens: 1_536,
      outputTokens: 90,
      costMicroUsd: 1_890n,
    });
  });

  it('is not written twice when a second writer tries to end the same generation', async () => {
    const answer = await write(
      { role: 'user', parts: said('q') },
      { role: 'assistant', parts: [], status: 'generating' },
    );
    await finishWith(answer, true);

    // The row is no longer `generating`, so the update matches nothing and the
    // transaction ends before the ledger is touched.
    const second = await finishWith(answer, true);

    expect(second).toBeNull();
    expect(await ledgerRows()).toHaveLength(1);
  });

  it('writes nothing for a generation that was never charged for', async () => {
    const answer = await write(
      { role: 'user', parts: said('q') },
      { role: 'assistant', parts: [], status: 'generating' },
    );

    await finishWith(answer, false);

    expect(await ledgerRows()).toEqual([]);
  });

  it('survives the conversation it was spent on being deleted', async () => {
    const answer = await write(
      { role: 'user', parts: said('q') },
      { role: 'assistant', parts: [], status: 'generating' },
    );
    await finishWith(answer, true);

    await harness.db.delete(messages).where(eq(messages.conversationId, room));

    // Money already spent must not go with the messages, or deleting a
    // conversation is how somebody gives themselves their quota back — and the
    // rebuilt total would come out lower than the truth.
    expect(await ledgerRows()).toHaveLength(1);
  });

  it('reads what an answer cost back onto the message a client sees', async () => {
    const answer = await write(
      { role: 'user', parts: said('q') },
      { role: 'assistant', parts: [], status: 'generating' },
    );

    const stored = await finishWith(answer, true);

    expect(stored?.usage).toEqual({
      inputTokens: 1_800,
      cachedInputTokens: 1_536,
      outputTokens: 90,
      costMicroUsd: '1890',
    });
  });

  it('says nothing about usage for a message that never ran a model', async () => {
    const answer = await write(
      { role: 'user', parts: said('q') },
      { role: 'assistant', parts: [], status: 'generating' },
    );

    const stored = await store.finish({
      messageId: answer.id,
      status: 'error',
      parts: [],
      verification: null,
      model: '',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cost: MicroUsd.ZERO,
      charge: null,
    });

    // Zero tokens reported as a usage would read as a measurement rather than
    // as the absence of one.
    expect(stored?.usage).toBeNull();
  });
});
