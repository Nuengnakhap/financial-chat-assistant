import type { ClientMessageId, ConversationId, UserId } from '@fca/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  insertConversation,
  insertUser,
  startHarness,
  type Harness,
} from '../../../shared/persistence/__tests__/harness';
import { messages } from '../../../shared/persistence/schema';
import { DrizzleConversationRepository } from '../drizzle-conversation.repository';
import { DrizzleMessageRepository } from '../drizzle-message.repository';

let h: Harness;
let conversationsRepo: DrizzleConversationRepository;
let messagesRepo: DrizzleMessageRepository;
let ada: UserId;
let grace: UserId;

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
  grace = await insertUser(h.db, 'grace@example.com');
});

const newId = (): ConversationId => crypto.randomUUID() as ConversationId;

const listMessages = (userId: UserId, conversationId: ConversationId, limit = 10) =>
  messagesRepo.listForConversation({ userId }, { conversationId, limit, cursor: null });

describe('one user cannot reach another user data', () => {
  it('hides a conversation that is not yours', async () => {
    const id = await insertConversation(h.db, ada);

    // Not "forbidden" — indistinguishable from absent, so the existence of
    // someone else's conversation cannot be probed.
    expect(await conversationsRepo.findById({ userId: grace }, id)).toBeNull();
    expect(await conversationsRepo.findById({ userId: ada }, id)).not.toBeNull();
  });

  it('lists only your own', async () => {
    await insertConversation(h.db, ada, 'Ada one');
    await insertConversation(h.db, ada, 'Ada two');
    await insertConversation(h.db, grace, 'Grace one');

    const mine = await conversationsRepo.listForOwner({ userId: ada }, { limit: 10, cursor: null });

    expect(mine.items.map((row) => row.title).sort()).toEqual(['Ada one', 'Ada two']);
  });

  it('hides messages in a conversation that is not yours', async () => {
    const id = await insertConversation(h.db, ada);
    await messagesRepo.append({
      conversationId: id,
      clientMessageId: null,
      role: 'user',
      parts: [{ kind: 'text', text: 'hello' }],
      status: 'complete',
    });

    expect((await listMessages(grace, id)).items).toEqual([]);
    expect((await listMessages(ada, id)).items).toHaveLength(1);
  });

  it('refuses to delete someone else conversation', async () => {
    const id = await insertConversation(h.db, ada);

    expect(await conversationsRepo.markDeleting({ userId: grace }, id, new Date())).toBe(false);
    // Still readable by its owner, which is how "nothing happened" is visible:
    // a conversation on its way out reads as absent.
    expect(await conversationsRepo.findById({ userId: ada }, id)).not.toBeNull();
  });

  it('removes only a conversation that was marked for it', async () => {
    // `purge` runs from a queue with no owner behind it, so `deleting` is what
    // stands in for the ownership check. An id that arrived from anywhere must
    // not be able to destroy a conversation someone is still using.
    const active = await insertConversation(h.db, ada, 'in use');

    expect(await conversationsRepo.purge(active)).toBe(false);
    expect(await conversationsRepo.findById({ userId: ada }, active)).not.toBeNull();
  });

  it('removes a conversation that was marked, and says so once', async () => {
    const id = await insertConversation(h.db, ada);
    await conversationsRepo.markDeleting({ userId: ada }, id, new Date());

    expect(await conversationsRepo.purge(id)).toBe(true);
    // The second answer is what a job delivered twice gets: nothing to do, and
    // not an error.
    expect(await conversationsRepo.purge(id)).toBe(false);
  });

  it('takes the messages with it', async () => {
    const id = await insertConversation(h.db, ada);
    await messagesRepo.append({
      conversationId: id,
      clientMessageId: null,
      role: 'user',
      parts: [{ kind: 'text', text: 'hello' }],
      status: 'complete',
    });
    await conversationsRepo.markDeleting({ userId: ada }, id, new Date());

    await conversationsRepo.purge(id);

    expect(await h.db.select().from(messages)).toEqual([]);
  });

  it('stops answering for a conversation once it is on its way out', async () => {
    const id = await insertConversation(h.db, ada);
    await conversationsRepo.markDeleting({ userId: ada }, id, new Date());

    // Not a state on the summary for a caller to check — the row is simply not
    // findable, so no use case can forget the rule.
    expect(await conversationsRepo.findById({ userId: ada }, id)).toBeNull();
  });
});

describe('deleting a conversation', () => {
  it('succeeds once and only once', async () => {
    const id = await insertConversation(h.db, ada);
    const now = new Date();

    expect(await conversationsRepo.markDeleting({ userId: ada }, id, now)).toBe(true);
    // Two concurrent deletes must not both start a pipeline.
    expect(await conversationsRepo.markDeleting({ userId: ada }, id, now)).toBe(false);
  });

  it('reports false for a conversation that never existed', async () => {
    expect(await conversationsRepo.markDeleting({ userId: ada }, newId(), new Date())).toBe(false);
  });
});

describe('appending a message', () => {
  const append = (conversationId: ConversationId, text: string) =>
    messagesRepo.append({
      conversationId,
      clientMessageId: null,
      role: 'user',
      parts: [{ kind: 'text', text }],
      status: 'complete',
    });

  it('numbers the first message one', async () => {
    const id = await insertConversation(h.db, ada);

    expect((await append(id, 'first')).seq).toBe(1);
  });

  it('numbers each following message in order', async () => {
    const id = await insertConversation(h.db, ada);

    await append(id, 'first');
    await append(id, 'second');

    expect((await append(id, 'third')).seq).toBe(3);
  });

  it('numbers conversations independently', async () => {
    const first = await insertConversation(h.db, ada);
    const second = await insertConversation(h.db, ada);
    await append(first, 'one');
    await append(first, 'two');

    expect((await append(second, 'one')).seq).toBe(1);
  });

  it('loses nothing when eight sends race for the same position', async () => {
    const id = await insertConversation(h.db, ada);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_unused, index) => append(id, `message ${String(index)}`)),
    );

    // Counting rejections is the whole test. Asserting only that the stored rows
    // are distinct and sorted passes just as happily when half of them were
    // dropped — which is exactly what happened before the retry existed.
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(0);

    const stored = await listMessages(ada, id, 20);
    expect(stored.items.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('still reports a duplicate client id rather than retrying it away', async () => {
    const id = await insertConversation(h.db, ada);
    const clientMessageId = crypto.randomUUID() as ClientMessageId;
    const send = () =>
      messagesRepo.append({
        conversationId: id,
        clientMessageId,
        role: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
        status: 'complete',
      });

    await send();

    // The retry is scoped to the sequence-number clash. A repeated client id is
    // the idempotency rule working and has to reach the caller.
    await expect(send()).rejects.toThrow();
  });

  it('returns the row it wrote, so a caller needs no second read', async () => {
    const id = await insertConversation(h.db, ada);

    const stored = await append(id, 'hello');

    expect(stored.conversationId).toBe(id);
    expect(stored.role).toBe('user');
    expect(stored.parts).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(stored.createdAt).toBeInstanceOf(Date);
  });

  it('tolerates a parts value that is not an array, rather than crashing a page', async () => {
    const id = await insertConversation(h.db, ada);
    // No CHECK constrains assistant parts, so an older or hand-edited row could
    // look like this; a page must still render.
    await h.db
      .insert(messages)
      .values({ conversationId: id, role: 'assistant', parts: {}, status: 'stopped', seq: 1 });

    const stored = await listMessages(ada, id);

    expect(stored.items[0]?.parts).toEqual([]);
  });

  it('reads messages back in the order they were sent', async () => {
    const id = await insertConversation(h.db, ada);
    await append(id, 'first');
    await append(id, 'second');
    await append(id, 'third');

    const stored = await listMessages(ada, id);

    expect(stored.items.map((message) => message.seq)).toEqual([1, 2, 3]);
  });
});
