import { ConversationId, type DomainEvent, type OwnerScope, type UserId } from '@fca/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TxContext, UnitOfWork } from '../../../shared/persistence/unit-of-work';
import { conversationCursor } from '../pagination';
import type { ConversationRepository } from '../ports/conversation.repository';
import { CreateConversationUseCase } from '../use-cases/create-conversation.use-case';
import { DescribeConversationUseCase } from '../use-cases/describe-conversation.use-case';
import { ListConversationsUseCase } from '../use-cases/list-conversations.use-case';
import { RemoveConversationUseCase } from '../use-cases/remove-conversation.use-case';

const ADA = 'e5c9f4a1-1f0e-4a6a-9d4e-0c8b6a3f21d0' as UserId;
const SCOPE: OwnerScope = { userId: ADA };
const ID = ConversationId.trusted('cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21');
const NOW = new Date('2026-08-31T04:05:06.789Z');

const summary = (overrides: Partial<{ title: string }> = {}) => ({
  id: ID,
  title: overrides.title ?? 'New chat',
  createdAt: NOW,
  updatedAt: NOW,
});

const create = vi.fn();
const findById = vi.fn();
const listForOwner = vi.fn();
const markDeleting = vi.fn();
const published: DomainEvent[] = [];

const repository = (): ConversationRepository => ({ create, findById, listForOwner, markDeleting });

/**
 * The real `UnitOfWork` contract with a fake body: `publish` buffers, and the
 * work runs once with only the repository the path under test touches. What
 * these specs are about is what a use case decides, not what a transaction does
 * with it — that is proven against a real database.
 */
const uow: UnitOfWork = {
  run: async (work) =>
    await work({
      conversations: repository(),
      publish: (event) => {
        published.push(event);
      },
    } as TxContext),
};

beforeEach(() => {
  vi.resetAllMocks();
  published.length = 0;
});

describe('creating a conversation', () => {
  it('writes one nobody has spoken in yet, and answers with it', async () => {
    const created = await new CreateConversationUseCase(uow).execute(SCOPE, NOW);

    expect(created.title).toBe('New chat');
    expect(created.createdAt).toBe(NOW);
    expect(created.updatedAt).toBe(NOW);
    expect(create).toHaveBeenCalledWith(SCOPE, {
      id: created.id,
      title: 'New chat',
      createdAt: NOW,
    });
  });

  it('tells nothing else about it', async () => {
    // An event with no consumer is a queue that only grows. When something
    // needs to know a conversation exists, that is when it gets published.
    await new CreateConversationUseCase(uow).execute(SCOPE, NOW);

    expect(published).toEqual([]);
  });

  it('gives each one an id of its own', async () => {
    const use = new CreateConversationUseCase(uow);

    const first = await use.execute(SCOPE, NOW);
    const second = await use.execute(SCOPE, NOW);

    expect(first.id).not.toBe(second.id);
  });
});

describe('listing conversations', () => {
  it('hands back a cursor a client can send again', async () => {
    listForOwner.mockResolvedValue({ items: [summary()], nextCursor: { updatedAt: NOW, id: ID } });

    const page = await new ListConversationsUseCase(uow).execute(SCOPE, { limit: 20 });

    expect(page.ok && page.value.items).toHaveLength(1);
    expect(page.ok && conversationCursor.decode(page.value.nextCursor ?? '')).toMatchObject({
      ok: true,
    });
  });

  it('says there is no next page rather than inventing one', async () => {
    listForOwner.mockResolvedValue({ items: [], nextCursor: null });

    const page = await new ListConversationsUseCase(uow).execute(SCOPE, { limit: 20 });

    expect(page.ok && page.value.nextCursor).toBeNull();
  });

  it('reads the position a cursor names', async () => {
    listForOwner.mockResolvedValue({ items: [], nextCursor: null });
    const cursor = conversationCursor.encode({ updatedAt: NOW, id: ID });

    await new ListConversationsUseCase(uow).execute(SCOPE, { limit: 5, cursor });

    expect(listForOwner).toHaveBeenCalledWith(SCOPE, {
      limit: 5,
      cursor: { updatedAt: NOW, id: ID },
    });
  });

  it('refuses a cursor that was edited, without asking the database', async () => {
    const page = await new ListConversationsUseCase(uow).execute(SCOPE, {
      limit: 20,
      cursor: 'not-a-cursor',
    });

    expect(!page.ok && page.error.code).toBe('validation');
    expect(listForOwner).not.toHaveBeenCalled();
  });
});

describe('reading one conversation', () => {
  it('answers with what the repository found', async () => {
    findById.mockResolvedValue(summary({ title: 'Revenue' }));

    const found = await new DescribeConversationUseCase(uow).execute(SCOPE, ID);

    expect(found.ok && found.value.title).toBe('Revenue');
  });

  it('answers not found when there is nothing to answer with', async () => {
    findById.mockResolvedValue(null);

    const found = await new DescribeConversationUseCase(uow).execute(SCOPE, ID);

    expect(!found.ok && found.error.code).toBe('not_found');
  });

  it('answers not found for an id that could not name anything', async () => {
    // Not a validation failure: a 400 here would separate "wrong shape" from
    // "not yours", which is half of what the 404 is hiding.
    const found = await new DescribeConversationUseCase(uow).execute(SCOPE, 'nonsense');

    expect(!found.ok && found.error.code).toBe('not_found');
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('asking for a conversation to go', () => {
  it('records the request in the same breath as hiding it', async () => {
    markDeleting.mockResolvedValue(true);

    const started = await new RemoveConversationUseCase(uow).execute(SCOPE, ID, NOW);

    expect(started.ok).toBe(true);
    expect(markDeleting).toHaveBeenCalledWith(SCOPE, ID, NOW);
    expect(published).toEqual([
      {
        aggregate: 'conversation',
        aggregateId: ID,
        type: 'conversation.delete_requested',
        payload: {},
      },
    ]);
  });

  it('tells nobody twice when the conversation was already going', async () => {
    // Two clicks, or a retry. The second must not queue a second deletion.
    markDeleting.mockResolvedValue(false);

    const started = await new RemoveConversationUseCase(uow).execute(SCOPE, ID, NOW);

    expect(!started.ok && started.error.code).toBe('not_found');
    expect(published).toEqual([]);
  });

  it('answers not found for an id that could not name anything', async () => {
    const started = await new RemoveConversationUseCase(uow).execute(SCOPE, 'nonsense', NOW);

    expect(!started.ok && started.error.code).toBe('not_found');
    expect(markDeleting).not.toHaveBeenCalled();
  });
});
