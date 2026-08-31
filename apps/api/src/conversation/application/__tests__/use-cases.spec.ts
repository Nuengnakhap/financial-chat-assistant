import {
  ClientMessageId,
  ConversationId,
  type DomainEvent,
  type OwnerScope,
  type UserId,
} from '@fca/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TxContext, UnitOfWork } from '../../../shared/persistence/unit-of-work';
import { conversationCursor } from '../pagination';
import type { ConversationRepository } from '../ports/conversation.repository';
import type { MessageRepository } from '../ports/message.repository';
import { AppendUserMessageUseCase } from '../use-cases/append-user-message.use-case';
import { CreateConversationUseCase } from '../use-cases/create-conversation.use-case';
import { DescribeConversationUseCase } from '../use-cases/describe-conversation.use-case';
import { ListConversationsUseCase } from '../use-cases/list-conversations.use-case';
import { PurgeConversationUseCase } from '../use-cases/purge-conversation.use-case';
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
const purge = vi.fn();
const touch = vi.fn();
const listForConversation = vi.fn();
const appendMessage = vi.fn();
const findByClientId = vi.fn();
const messageRepository = (): MessageRepository => ({
  append: appendMessage,
  findByClientId,
  listForConversation,
});

/** What the driver hands up, wrapped the way drizzle wraps it. */
const violation = (code: string, constraint: string): Error =>
  new Error('Failed query', { cause: Object.assign(new Error('rejected'), { code, constraint }) });
const published: DomainEvent[] = [];

const repository = (): ConversationRepository => ({
  create,
  findById,
  listForOwner,
  markDeleting,
  purge,
  touch,
});

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
      messages: messageRepository(),
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

describe('finishing a deletion', () => {
  it('removes the conversation the event names', async () => {
    purge.mockResolvedValue(true);

    expect(await new PurgeConversationUseCase(uow).execute(ID)).toBe(true);
    expect(purge).toHaveBeenCalledWith(ID);
  });

  it('reports nothing removed rather than failing when the job arrives twice', async () => {
    // At-least-once delivery makes this the ordinary case, not the exception.
    // A throw here would turn a duplicate into a job that never completes.
    purge.mockResolvedValue(false);

    expect(await new PurgeConversationUseCase(uow).execute(ID)).toBe(false);
  });
});

describe('writing what somebody sent', () => {
  const CLIENT_ID = ClientMessageId.trusted('9b1e2f3a-4c5d-4e6f-8a9b-0c1d2e3f4a5b');
  const sent = { conversationId: ID, clientMessageId: CLIENT_ID, content: 'hello' };
  const written = {
    id: '2b8e1b4a-6a1e-4d5e-9c3f-0f1a2b3c4d5e',
    seq: 1,
    createdAt: NOW,
  };

  it('answers not found when the conversation went while it was being written to', () => {
    // The delete pipeline can take the row away between the read and the write,
    // and the foreign key is what notices. A caller asked to write into
    // something that is not there, which is the answer they get for asking to
    // write into somebody else's.
    findById.mockResolvedValue(summary());
    appendMessage.mockRejectedValue(
      violation('23503', 'messages_conversation_id_conversations_id_fk'),
    );

    return expect(new AppendUserMessageUseCase(uow).execute(SCOPE, sent)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('answers with the message it already wrote when the send is a repeat', async () => {
    findById.mockResolvedValue(summary());
    appendMessage.mockRejectedValue(violation('23505', 'uq_message_client_id'));
    findByClientId.mockResolvedValue(written);

    const again = await new AppendUserMessageUseCase(uow).execute(SCOPE, sent);

    expect(again.ok && again.value.created).toBe(false);
    expect(again.ok && again.value.message.id).toBe(written.id);
  });

  it('raises anything else rather than dressing it as a missing conversation', async () => {
    // A constraint nobody planned for is a bug, and a 404 would hide it.
    findById.mockResolvedValue(summary());
    appendMessage.mockRejectedValue(violation('23514', 'chk_user_message_length'));

    await expect(new AppendUserMessageUseCase(uow).execute(SCOPE, sent)).rejects.toThrow(
      'Failed query',
    );
  });

  it('names the conversation after the first message and leaves the rest alone', async () => {
    findById.mockResolvedValue(summary());
    appendMessage.mockResolvedValue({ ...written, seq: 1 });
    await new AppendUserMessageUseCase(uow).execute(SCOPE, sent);
    expect(touch).toHaveBeenCalledWith(SCOPE, { id: ID, at: NOW, title: 'hello' });

    appendMessage.mockResolvedValue({ ...written, seq: 2 });
    await new AppendUserMessageUseCase(uow).execute(SCOPE, sent);
    expect(touch).toHaveBeenLastCalledWith(SCOPE, { id: ID, at: NOW, title: null });
  });

  it('writes nothing into a conversation that is not the sender to write in', async () => {
    findById.mockResolvedValue(null);

    const refused = await new AppendUserMessageUseCase(uow).execute(SCOPE, sent);

    expect(!refused.ok && refused.error.code).toBe('not_found');
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
