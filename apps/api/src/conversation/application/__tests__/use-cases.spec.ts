import {
  BudgetExceededError,
  ClientMessageId,
  ConversationId,
  Err,
  Ok,
  ReservationId,
  type DomainEvent,
  type Result,
  type OwnerScope,
  type Reservation,
  type UserId,
} from '@fca/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TxContext, UnitOfWork } from '../../../shared/persistence/unit-of-work';
import { conversationCursor, messageCursor } from '../pagination';
import type { GenerationBudget } from '../ports/budget.port';
import type { ConversationRepository } from '../ports/conversation.repository';
import type { MessageRepository } from '../ports/message.repository';
import { CreateConversationUseCase } from '../use-cases/create-conversation.use-case';
import { DescribeConversationUseCase } from '../use-cases/describe-conversation.use-case';
import { ListConversationsUseCase } from '../use-cases/list-conversations.use-case';
import { ListMessagesUseCase } from '../use-cases/list-messages.use-case';
import { PurgeConversationUseCase } from '../use-cases/purge-conversation.use-case';
import { RemoveConversationUseCase } from '../use-cases/remove-conversation.use-case';
import { StartGenerationUseCase } from '../use-cases/start-generation.use-case';

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
const findBySeq = vi.fn();
const messageRepository = (): MessageRepository => ({
  append: appendMessage,
  findByClientId,
  findBySeq,
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

describe('reading the history of a conversation', () => {
  const page = { limit: 100 };

  it('answers not found before it reads a single message', async () => {
    // An empty page and a conversation that is not yours read the same on a
    // screen, and the difference is what tells an asker their id was real.
    findById.mockResolvedValue(null);

    const history = await new ListMessagesUseCase(uow).execute(SCOPE, ID, page);

    expect(!history.ok && history.error.code).toBe('not_found');
    expect(listForConversation).not.toHaveBeenCalled();
  });

  it('hands back a cursor that names where it stopped', async () => {
    findById.mockResolvedValue(summary());
    listForConversation.mockResolvedValue({ items: [], nextCursor: { seq: 12 } });

    const history = await new ListMessagesUseCase(uow).execute(SCOPE, ID, page);

    expect(history.ok && messageCursor.decode(history.value.nextCursor ?? '')).toMatchObject({
      ok: true,
      value: { seq: 12 },
    });
  });

  it('says there is nothing older rather than inventing a page', async () => {
    findById.mockResolvedValue(summary());
    listForConversation.mockResolvedValue({ items: [], nextCursor: null });

    const history = await new ListMessagesUseCase(uow).execute(SCOPE, ID, page);

    expect(history.ok && history.value.nextCursor).toBeNull();
  });

  it('refuses an edited cursor without asking the database anything', async () => {
    const history = await new ListMessagesUseCase(uow).execute(SCOPE, ID, {
      ...page,
      cursor: 'not-a-cursor',
    });

    expect(!history.ok && history.error.code).toBe('validation');
    expect(findById).not.toHaveBeenCalled();
  });

  it('answers not found for an id that could not name a conversation', async () => {
    const history = await new ListMessagesUseCase(uow).execute(SCOPE, 'nonsense', page);

    expect(!history.ok && history.error.code).toBe('not_found');
  });
});

describe('starting an answer', () => {
  const CLIENT_ID = ClientMessageId.trusted('9b1e2f3a-4c5d-4e6f-8a9b-0c1d2e3f4a5b');
  const sent = { conversationId: ID, clientMessageId: CLIENT_ID, content: 'hello' };
  const RESERVATION: Reservation = {
    userId: SCOPE.userId,
    id: ReservationId.trusted('0d4a1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2d'),
    windowStart: NOW,
  };
  /** Granted unless a test says otherwise; releases are counted. */
  const reserve: GenerationBudget['reserve'] = vi.fn(
    async () => await Promise.resolve<Result<Reservation, BudgetExceededError>>(Ok(RESERVATION)),
  );
  const release = vi.fn(async () => await Promise.resolve());
  const reserved = vi.mocked(reserve);
  const budget: GenerationBudget = { reserve, release };
  const question = { id: '2b8e1b4a-6a1e-4d5e-9c3f-0f1a2b3c4d5e', seq: 1, createdAt: NOW };
  const answer = { id: '7f3c9d2e-5b4a-4c1d-8e6f-9a0b1c2d3e4f', seq: 2, createdAt: NOW };

  /** The two rows one send writes, in the order the transaction writes them. */
  const bothRowsWritten = (): void => {
    appendMessage.mockResolvedValueOnce(question).mockResolvedValueOnce(answer);
  };

  const start = () => new StartGenerationUseCase(uow, budget).execute(SCOPE, sent);

  beforeEach(() => {
    reserved.mockResolvedValue(Ok(RESERVATION));
    release.mockClear();
  });

  it('writes the question, the row its answer goes in, and the event that starts one', async () => {
    findById.mockResolvedValue(summary());
    bothRowsWritten();

    const started = await start();

    expect(started.ok && started.value).toEqual({ assistantMessageId: answer.id, resumed: false });
    // The placeholder is `generating` before anything reads it, which is what the
    // partial unique index counts and what the janitor later looks for.
    expect(appendMessage).toHaveBeenNthCalledWith(2, {
      conversationId: ID,
      clientMessageId: null,
      role: 'assistant',
      parts: [],
      status: 'generating',
      // The claim goes down with the row it belongs to. Written afterwards, a
      // crash in between leaves an answer nothing can ever give the budget back
      // for — and the process that would have known is the one that died.
      reservation: RESERVATION,
    });
    // Buffered by the same unit of work that wrote the rows: the runner cannot
    // be told about an answer that was rolled back.
    expect(published).toEqual([
      {
        aggregate: 'message',
        aggregateId: answer.id,
        type: 'generation.requested',
        payload: { conversationId: ID, userId: ADA },
      },
    ]);
  });

  it('refuses before writing anything down when the budget is spent', async () => {
    reserved.mockResolvedValue(Err(new BudgetExceededError('Not enough budget remains.')));

    const refused = await start();

    expect(!refused.ok && refused.error.code).toBe('budget_exceeded');
    // Nothing was stored and nothing was started: a question written down
    // against a refusal sits in the transcript with no answer ever coming.
    expect(appendMessage).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('gives the claim back for every ending that is not a generation', async () => {
    findById.mockResolvedValue(summary());
    appendMessage.mockRejectedValue(violation('23505', 'uq_active_generation'));

    await start();

    // Held before the transaction and unusable after it failed. Left held, a
    // burst of refused sends would eat somebody's window without answering
    // anything.
    expect(release).toHaveBeenCalledWith(RESERVATION);
  });

  it('gives the claim back when the conversation turns out not to be there', async () => {
    // The transaction rolls back without throwing, so nothing else would notice.
    findById.mockResolvedValue(null);

    await start();

    expect(release).toHaveBeenCalledWith(RESERVATION);
  });

  it('keeps the claim when an answer really is about to be written', async () => {
    findById.mockResolvedValue(summary());
    bothRowsWritten();

    await start();

    expect(release).not.toHaveBeenCalled();
  });

  it('answers not found when the conversation went while it was being written to', () => {
    // The delete pipeline can take the row away between the read and the write,
    // and the foreign key is what notices. A caller asked to write into
    // something that is not there, which is the answer they get for asking to
    // write into somebody else's.
    findById.mockResolvedValue(summary());
    appendMessage.mockRejectedValue(
      violation('23503', 'messages_conversation_id_conversations_id_fk'),
    );

    return expect(start()).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('refuses a second question while the first is still being answered', async () => {
    // G1 as a partial unique index, not as a read: two sends can both find no
    // generation in progress, and only the constraint can settle which of them
    // started one.
    findById.mockResolvedValue(summary());
    appendMessage
      .mockResolvedValueOnce(question)
      .mockRejectedValueOnce(violation('23505', 'uq_active_generation'));

    const refused = await start();

    expect(!refused.ok && refused.error.code).toBe('conflict');
    expect(published).toEqual([]);
  });

  it('attaches a repeated send to the answer already being written for it', async () => {
    findById.mockResolvedValue(summary());
    appendMessage.mockRejectedValue(violation('23505', 'uq_message_client_id'));
    findByClientId.mockResolvedValue(question);
    findBySeq.mockResolvedValue(answer);

    const again = await start();

    expect(again.ok && again.value).toEqual({ assistantMessageId: answer.id, resumed: true });
    // The link between a question and its answer is the position after it.
    expect(findBySeq).toHaveBeenCalledWith(ID, question.seq + 1);
    // Nothing new was started, so nothing new was announced.
    expect(published).toEqual([]);
  });

  it('raises the conflict rather than inventing an answer nobody can find', async () => {
    // The constraint says the row is there. If it is not, something is wrong
    // that a made-up message id would hide.
    findById.mockResolvedValue(summary());
    appendMessage.mockRejectedValue(violation('23505', 'uq_message_client_id'));
    findByClientId.mockResolvedValue(question);
    findBySeq.mockResolvedValue(null);

    await expect(start()).rejects.toThrow('Failed query');
  });

  it('raises anything else rather than dressing it as a missing conversation', async () => {
    // A constraint nobody planned for is a bug, and a 404 would hide it.
    findById.mockResolvedValue(summary());
    appendMessage.mockRejectedValue(violation('23514', 'chk_user_message_length'));

    await expect(start()).rejects.toThrow('Failed query');
  });

  it('names the conversation after the first message and leaves the rest alone', async () => {
    findById.mockResolvedValue(summary());
    bothRowsWritten();
    await start();
    expect(touch).toHaveBeenCalledWith(SCOPE, { id: ID, at: NOW, title: 'hello' });

    appendMessage.mockResolvedValueOnce({ ...question, seq: 3 }).mockResolvedValueOnce(answer);
    await start();
    expect(touch).toHaveBeenLastCalledWith(SCOPE, { id: ID, at: NOW, title: null });
  });

  it('writes nothing into a conversation that is not the sender to write in', async () => {
    findById.mockResolvedValue(null);

    const refused = await start();

    expect(!refused.ok && refused.error.code).toBe('not_found');
    expect(appendMessage).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });
});
