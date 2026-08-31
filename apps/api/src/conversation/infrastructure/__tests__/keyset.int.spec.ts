import { ConversationId, type Result, type UserId, type ValidationError } from '@fca/domain';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  insertConversation,
  insertUser,
  startHarness,
  type Harness,
} from '../../../shared/persistence/__tests__/harness';
import { conversations } from '../../../shared/persistence/schema';
import {
  conversationCursor,
  messageCursor,
  type ConversationCursor,
  type MessageCursor,
} from '../../application/pagination';
import {
  conversationPageQuery,
  DrizzleConversationRepository,
} from '../drizzle-conversation.repository';
import { DrizzleMessageRepository, messagePageQuery } from '../drizzle-message.repository';

let h: Harness;
let conversationsRepo: DrizzleConversationRepository;
let messagesRepo: DrizzleMessageRepository;
let ada: UserId;

beforeAll(async () => {
  h = await startHarness();
  conversationsRepo = new DrizzleConversationRepository(h.db);
  messagesRepo = new DrizzleMessageRepository(h.db);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  ada = await insertUser(h.db, 'ada@example.com');
});

const scope = (): { userId: UserId } => ({ userId: ada });

/**
 * Walks every page the way a client does, and reports what it saw in order.
 *
 * The requests are serial because that is the whole subject: each one needs the
 * cursor the one before it returned.
 */
/* eslint-disable no-await-in-loop */
async function readAll(limit: number): Promise<readonly string[]> {
  const seen: string[] = [];
  let cursor: ConversationCursor | null = null;

  for (let guard = 0; guard < 20; guard += 1) {
    const page = await conversationsRepo.listForOwner(scope(), { limit, cursor });
    seen.push(...page.items.map((row) => row.title));
    if (page.nextCursor === null) return seen;
    cursor = page.nextCursor;
  }

  throw new Error('the pages never ended');
}

/** The same walk backwards through a conversation, oldest page last to arrive. */
async function readAllMessages(
  conversationId: ConversationId,
  limit: number,
): Promise<readonly number[]> {
  const seen: number[] = [];
  let cursor: MessageCursor | null = null;

  for (let guard = 0; guard < 20; guard += 1) {
    const page = await messagesRepo.listForConversation(scope(), { conversationId, limit, cursor });
    seen.unshift(...page.items.map((row) => row.seq));
    if (page.nextCursor === null) return seen;
    cursor = page.nextCursor;
  }

  throw new Error('the pages never ended');
}
/* eslint-enable no-await-in-loop */

const BASE = new Date('2026-08-31T00:00:00.000Z');

/**
 * A conversation per second, newest last. The explicit clock matters: rows
 * written in a loop share a millisecond often enough that ordering falls to the
 * random id, and then the expectations below would be asserting the shuffle.
 */
async function insertRooms(titles: readonly string[]): Promise<void> {
  await h.db.insert(conversations).values(
    titles.map((title, index) => {
      const at = new Date(BASE.getTime() + index * 1000);
      return { userId: ada, title, createdAt: at, updatedAt: at };
    }),
  );
}

async function fillConversations(count: number): Promise<void> {
  // One statement rather than a loop: the point of the row count is the query
  // planner, and paying for 20,000 round trips would make this test the reason
  // nobody runs the suite.
  await h.db.execute(sql`
    INSERT INTO conversations (user_id, title, created_at, updated_at)
    SELECT ${ada}::uuid, 'room ' || g, now() - (g * interval '1 second'), now() - (g * interval '1 second')
    FROM generate_series(1, ${count}::int) AS g
  `);
  await h.db.execute(sql`ANALYZE conversations`);
}

async function fillMessages(conversationId: ConversationId, count: number): Promise<void> {
  await h.db.execute(sql`
    INSERT INTO messages (conversation_id, role, parts, status, seq)
    SELECT ${conversationId}::uuid, 'user', '["x"]'::jsonb, 'complete', g
    FROM generate_series(1, ${count}::int) AS g
  `);
  await h.db.execute(sql`ANALYZE messages`);
}

/**
 * The plan of the statement the repository runs, not of a copy written here —
 * which is why both query builders are exported. Serialised rather than read
 * field by field: the assertions below are about text PostgreSQL prints.
 */
async function planOf(statement: SQL): Promise<string> {
  const explained = await h.db.execute(sql`explain ${statement}`);

  return JSON.stringify(explained.rows);
}

describe('paging through conversations', () => {
  it('shows every conversation exactly once', async () => {
    await insertRooms(['one', 'two', 'three', 'four', 'five', 'six', 'seven']);

    const seen = await readAll(3);

    expect(seen).toEqual(['seven', 'six', 'five', 'four', 'three', 'two', 'one']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('ends the last page without offering another', async () => {
    // Six rows and a limit of three: the last page is full, and deciding from
    // `items.length === limit` would offer a page that comes back empty.
    await insertRooms(['one', 'two', 'three', 'four', 'five', 'six']);

    const first = await conversationsRepo.listForOwner(scope(), { limit: 3, cursor: null });
    const second = await conversationsRepo.listForOwner(scope(), {
      limit: 3,
      cursor: first.nextCursor,
    });

    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
  });

  it('neither repeats nor skips when a conversation arrives between two pages', async () => {
    // The failure offset has and keyset does not: a new row at the top pushes
    // every later position along by one, so the row at the boundary is read
    // twice and the one after it never.
    await insertRooms(['one', 'two', 'three', 'four']);

    const first = await conversationsRepo.listForOwner(scope(), { limit: 2, cursor: null });
    const later = new Date(BASE.getTime() + 60_000);
    await h.db
      .insert(conversations)
      .values({ userId: ada, title: 'arrived late', createdAt: later, updatedAt: later });
    const second = await conversationsRepo.listForOwner(scope(), {
      limit: 2,
      cursor: first.nextCursor,
    });

    const seen = [...first.items, ...second.items].map((row) => row.title);
    expect(seen).toEqual(['four', 'three', 'two', 'one']);
  });

  it('keeps its place when several conversations share one millisecond', async () => {
    // The clock alone is not a key. Four rows at the same instant page correctly
    // only because the id is part of the ordering and of the comparison — drop
    // it from either and this repeats one row and loses another.
    await h.db.insert(conversations).values(
      ['a', 'b', 'c', 'd'].map((title) => ({
        userId: ada,
        title,
        createdAt: BASE,
        updatedAt: BASE,
      })),
    );

    const seen = await readAll(2);

    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not step over a row whose clock differs below what anything can read', async () => {
    // A cursor is built from an instant the application read back, and a
    // JavaScript Date holds milliseconds. Written at microsecond precision
    // these two rows are distinct to the database and identical to every reader
    // of them, so the page taken after the first would skip the second and lose
    // it for good. `updated_at` is declared to the millisecond for this reason;
    // undo that and this goes red.
    await h.db.execute(sql`
      INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES
        (${ada}::uuid, 'earlier', '2026-08-31 00:00:00.000123Z'::timestamptz, '2026-08-31 00:00:00.000123Z'::timestamptz),
        (${ada}::uuid, 'later', '2026-08-31 00:00:00.000456Z'::timestamptz, '2026-08-31 00:00:00.000456Z'::timestamptz)
    `);

    expect([...(await readAll(1))].sort()).toEqual(['earlier', 'later']);
  });

  it('leaves out a conversation that is on its way out', async () => {
    const doomed = await insertConversation(h.db, ada, 'doomed');
    await insertConversation(h.db, ada, 'kept');
    await conversationsRepo.markDeleting(scope(), doomed, new Date());

    expect(await readAll(50)).toEqual(['kept']);
  });

  it('reads a page through the index rather than scanning the table', async () => {
    // The whole reason to page by keyset. With the index gone or the ordering
    // changed to something it cannot serve, this reports a sequential scan —
    // which is the failure that otherwise shows up as a slow list months later.
    await fillConversations(20_000);
    const cursor: ConversationCursor = {
      updatedAt: new Date(),
      id: ConversationId.trusted('00000000-0000-4000-8000-000000000000'),
    };

    const plan = await planOf(conversationPageQuery(h.db, scope(), { limit: 50, cursor }).getSQL());

    expect(plan).toContain('Index Scan Backward using idx_conversations_owner_recent');
    expect(plan).not.toContain('Seq Scan');
  });
});

/** A cursor this file built itself: a refusal here is a bug in the test. */
function mustDecode<T>(result: Result<T, ValidationError>): T {
  if (!result.ok) throw new Error(`the codec refused a cursor it wrote: ${result.error.message}`);

  return result.value;
}

describe('the widest cursor each codec accepts', () => {
  it('is one the database can bind', async () => {
    // The cross-check between what the codec allows and what the column holds.
    // Before the bounds were the column's, the values just past these reached
    // the driver — `out of range for type integer` and `timestamp out of range`
    // — as a 500 built from a string the caller chose.
    const id = await insertConversation(h.db, ada, 'only one');
    await fillMessages(id, 1);

    const lastSeq = mustDecode(messageCursor.decode(messageCursor.encode({ seq: 2_147_483_647 })));
    const at = (iso: string): ConversationCursor =>
      mustDecode(
        conversationCursor.decode(conversationCursor.encode({ updatedAt: new Date(iso), id })),
      );

    const messages = await messagesRepo.listForConversation(scope(), {
      conversationId: id,
      limit: 10,
      cursor: lastSeq,
    });
    const latest = await conversationsRepo.listForOwner(scope(), {
      limit: 10,
      cursor: at('9999-12-31T23:59:59.999Z'),
    });
    const earliest = await conversationsRepo.listForOwner(scope(), {
      limit: 10,
      cursor: at('0000-01-01T00:00:00.000Z'),
    });

    expect(messages.items).toHaveLength(1);
    expect(latest.items.map((row) => row.title)).toEqual(['only one']);
    expect(earliest.items).toEqual([]);
  });
});

describe('paging through the messages of a conversation', () => {
  const seqsOf = (items: readonly { readonly seq: number }[]) => items.map((row) => row.seq);

  it('opens at the end of the conversation, in reading order', async () => {
    const id = await insertConversation(h.db, ada);
    await fillMessages(id, 10);

    const page = await messagesRepo.listForConversation(scope(), {
      conversationId: id,
      limit: 3,
      cursor: null,
    });

    expect(seqsOf(page.items)).toEqual([8, 9, 10]);
  });

  it('walks backwards to the start and stops there', async () => {
    const id = await insertConversation(h.db, ada);
    await fillMessages(id, 7);

    expect(await readAllMessages(id, 3)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('hides the messages of a conversation that is on its way out', async () => {
    const id = await insertConversation(h.db, ada);
    await fillMessages(id, 3);
    await conversationsRepo.markDeleting(scope(), id, new Date());

    const page = await messagesRepo.listForConversation(scope(), {
      conversationId: id,
      limit: 10,
      cursor: null,
    });

    expect(page.items).toEqual([]);
  });

  it('reads a page through the sequence index rather than scanning the messages', async () => {
    const id = await insertConversation(h.db, ada);
    await fillMessages(id, 20_000);

    const plan = await planOf(
      messagePageQuery(h.db, scope(), {
        conversationId: id,
        limit: 100,
        cursor: { seq: 15_000 },
      }).getSQL(),
    );

    expect(plan).toContain('Index Scan Backward using uq_message_seq');
    expect(plan).not.toContain('Seq Scan');
  });
});
