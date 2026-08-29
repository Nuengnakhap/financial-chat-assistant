import type { ConversationId, UserId } from '@fca/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DrizzleUnitOfWork } from '../drizzle-unit-of-work';
import { conversations, messages, outboxEvents } from '../schema';
import { insertUser, startHarness, violationOf, type Harness } from './harness';
import type { DatabaseService } from '../database.service';

/**
 * The dual-write problem, tested from both sides: a change and the event that
 * announces it either both land or neither does. Writing the row and then
 * enqueueing has a window in which a crash leaves a message nobody will ever
 * generate — these tests are what says that window is closed.
 */

let h: Harness;
let uow: DrizzleUnitOfWork;
let userId: UserId;

beforeAll(async () => {
  h = await startHarness();
  // Only `db` is used by the unit of work; the pool lifecycle is the harness's.
  uow = new DrizzleUnitOfWork({ db: h.db } as unknown as DatabaseService);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  userId = await insertUser(h.db, 'ada@example.com');
});

const newId = (): ConversationId => crypto.randomUUID() as ConversationId;

const created = (id: ConversationId) =>
  ({
    aggregate: 'conversation',
    aggregateId: id,
    type: 'conversation.created',
    payload: {},
  }) as const;

describe('a successful unit of work', () => {
  it('commits the state and the event together', async () => {
    const id = newId();

    await uow.run(async (ctx) => {
      await ctx.conversations.create(
        { userId },
        { id: id, title: 'Revenue', createdAt: new Date() },
      );
      ctx.publish({ ...created(id), payload: { title: 'Revenue' } });
    });

    expect(await h.db.select().from(conversations)).toHaveLength(1);
    const events = await h.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('conversation.created');
  });

  it('writes several events in the order they were published', async () => {
    const id = newId();

    await uow.run(async (ctx) => {
      await ctx.conversations.create(
        { userId },
        { id: id, title: 'Revenue', createdAt: new Date() },
      );
      ctx.publish(created(id));
      ctx.publish({ ...created(id), type: 'message.appended' });
    });

    const events = await h.db.select().from(outboxEvents).orderBy(outboxEvents.id);
    expect(events.map((event) => event.type)).toEqual(['conversation.created', 'message.appended']);
  });

  it('leaves every event unpublished, for the relay to claim', async () => {
    const id = newId();

    await uow.run(async (ctx) => {
      await ctx.conversations.create(
        { userId },
        { id: id, title: 'Revenue', createdAt: new Date() },
      );
      ctx.publish(created(id));
    });

    expect((await h.db.select().from(outboxEvents))[0]?.publishedAt).toBeNull();
  });

  it('writes nothing to the outbox when nothing was published', async () => {
    await uow.run(async (ctx) => {
      await ctx.conversations.create(
        { userId },
        { id: newId(), title: 'Revenue', createdAt: new Date() },
      );
    });

    expect(await h.db.select().from(outboxEvents)).toEqual([]);
  });
});

describe('a failing unit of work', () => {
  it('rolls the event back with the state it announced', async () => {
    const id = newId();

    await expect(
      uow.run(async (ctx) => {
        await ctx.conversations.create(
          { userId },
          { id: id, title: 'Revenue', createdAt: new Date() },
        );
        ctx.publish(created(id));
        throw new Error('the use case decided otherwise');
      }),
    ).rejects.toThrow('the use case decided otherwise');

    expect(await h.db.select().from(conversations)).toEqual([]);
    expect(await h.db.select().from(outboxEvents)).toEqual([]);
  });

  it('rolls back when the database refuses, not only when code throws', async () => {
    const id = newId();

    const reason = await violationOf(() =>
      uow.run(async (ctx) => {
        await ctx.conversations.create(
          { userId },
          { id: id, title: 'Revenue', createdAt: new Date() },
        );
        ctx.publish(created(id));
        // The second row violates chk_conversation_title_length.
        await ctx.conversations.create(
          { userId },
          { id: newId(), title: '', createdAt: new Date() },
        );
      }),
    );

    expect(reason).toContain('chk_conversation_title_length');
    expect(await h.db.select().from(conversations)).toEqual([]);
    expect(await h.db.select().from(outboxEvents)).toEqual([]);
  });

  it('leaves earlier committed work alone', async () => {
    await uow.run(async (ctx) => {
      await ctx.conversations.create(
        { userId },
        { id: newId(), title: 'Kept', createdAt: new Date() },
      );
    });

    await expect(
      uow.run(async (ctx) => {
        await ctx.conversations.create(
          { userId },
          { id: newId(), title: 'Discarded', createdAt: new Date() },
        );
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    const rows = await h.db.select().from(conversations);
    expect(rows.map((row) => row.title)).toEqual(['Kept']);
  });
});

describe('repositories inside the transaction', () => {
  it('see one another writes before the commit', async () => {
    const id = newId();

    const seen = await uow.run(async (ctx) => {
      await ctx.conversations.create(
        { userId },
        { id: id, title: 'Revenue', createdAt: new Date() },
      );
      await ctx.messages.append({
        conversationId: id,
        clientMessageId: null,
        role: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
        status: 'complete',
      });
      return await ctx.messages.listForConversation({ userId }, id, 10);
    });

    expect(seen).toHaveLength(1);
    expect(await h.db.select().from(messages)).toHaveLength(1);
  });
});
