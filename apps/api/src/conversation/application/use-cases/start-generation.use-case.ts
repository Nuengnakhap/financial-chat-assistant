import {
  ConflictError,
  Err,
  Ok,
  isErr,
  titleFromMessage,
  type ClientMessageId,
  type ConversationId,
  type DomainError,
  type MessageId,
  type OwnerScope,
  type Reservation,
  type Result,
} from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import {
  isForeignKeyViolationOf,
  isUniqueViolationOf,
} from '../../../shared/persistence/pg-errors';
import {
  UNIT_OF_WORK,
  type TxContext,
  type UnitOfWork,
} from '../../../shared/persistence/unit-of-work';
import { conversationGone } from '../conversation-id';
import { GENERATION_BUDGET, type GenerationBudget } from '../ports/budget.port';
import type { StoredMessage } from '../ports/message.repository';

export interface StartGeneration {
  readonly conversationId: ConversationId;
  readonly clientMessageId: ClientMessageId;
  readonly content: string;
}

/** A send, plus the claim held for the answer it is about to be given. */
interface Asked extends StartGeneration {
  readonly reservation: Reservation;
}

export interface StartedGeneration {
  /** The row the answer will be written into; the client attaches to its stream. */
  readonly assistantMessageId: MessageId;
  /** True when this send had already been accepted, so nothing new was started. */
  readonly resumed: boolean;
}

/** The first message in a conversation is the one that names it. */
const FIRST = 1;

/**
 * The conversation was there when it was read and gone when it was written to,
 * which the delete pipeline can do between two statements of this transaction.
 */
const CONVERSATION_FK = 'messages_conversation_id_conversations_id_fk';

/**
 * Everything that has to be true before a generation can begin, in one
 * transaction: the question is stored, the answer has a row to be written into,
 * and the event that sets a runner going is in the outbox beside them.
 *
 * There is no moment where any of those exists without the others. Storing the
 * question and then enqueueing would leave a question nobody will ever answer if
 * the process dies between the two, and enqueueing first would set a runner
 * looking for a row that was rolled back.
 */
@Injectable()
export class StartGenerationUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(GENERATION_BUDGET) private readonly budget: GenerationBudget,
  ) {}

  async execute(
    scope: OwnerScope,
    sent: StartGeneration,
  ): Promise<Result<StartedGeneration, DomainError>> {
    // Before the transaction, because it is not a database write and cannot
    // join one — and before the question is stored, because a question written
    // down against a refusal sits in the transcript with no answer coming.
    const held = await this.budget.reserve(scope.userId);
    if (isErr(held)) return held;

    try {
      return await this.startWith(held.value, scope, sent);
    } catch (error) {
      // Nothing below this line starts a generation, so the claim goes back
      // here rather than in each of the four ways this can end.
      await this.budget.release(held.value);
      if (isForeignKeyViolationOf(error, CONVERSATION_FK)) return Err(conversationGone());
      // G1, held by a partial unique index: a conversation has at most one
      // answer being written at a time. The second question is refused rather
      // than queued, because a queued one would be answered against a
      // transcript the asker has not read yet.
      if (isUniqueViolationOf(error, 'uq_active_generation')) {
        return Err(new ConflictError('A generation is already running in this conversation.'));
      }
      if (!isUniqueViolationOf(error, 'uq_message_client_id')) throw error;

      return await this.recall(sent, error);
    }
  }

  /**
   * A conversation that turned out not to be there is a generation that will
   * not happen, and the claim held for it goes back — the transaction rolled
   * back without throwing, so nothing else would notice.
   */
  private async startWith(
    reservation: Reservation,
    scope: OwnerScope,
    sent: StartGeneration,
  ): Promise<Result<StartedGeneration, DomainError>> {
    const started = await this.uow.run(
      async (ctx) => await this.write(ctx, scope, { ...sent, reservation }),
    );
    if (isErr(started)) await this.budget.release(reservation);

    return started;
  }

  /**
   * No read before the write. Two requests carrying the same client id can both
   * find nothing and both proceed, so checking first would narrow the window
   * rather than close it — `uq_message_client_id` is what closes it, and the read
   * that matters happens after the constraint has spoken.
   */
  private async write(
    ctx: TxContext,
    scope: OwnerScope,
    sent: Asked,
  ): Promise<Result<StartedGeneration, DomainError>> {
    const conversation = await ctx.conversations.findById(scope, sent.conversationId);
    if (conversation === null) return Err(conversationGone());

    const question = await ctx.messages.append({
      conversationId: sent.conversationId,
      clientMessageId: sent.clientMessageId,
      role: 'user',
      parts: [{ kind: 'text', text: sent.content }],
      status: 'complete',
    });
    const answer = await ctx.messages.append({
      conversationId: sent.conversationId,
      clientMessageId: null,
      role: 'assistant',
      parts: [],
      status: 'generating',
      reservation: sent.reservation,
    });

    // Named and reordered in the same transaction as the message. A title
    // written afterwards is a title a crash can leave describing a message that
    // was rolled back.
    await ctx.conversations.touch(scope, {
      id: sent.conversationId,
      at: question.createdAt,
      title: question.seq === FIRST ? titleFromMessage(sent.content) : null,
    });

    ctx.publish({
      aggregate: 'message',
      aggregateId: answer.id,
      type: 'generation.requested',
      payload: { conversationId: sent.conversationId, userId: scope.userId },
    });

    return Ok({ assistantMessageId: answer.id, resumed: false });
  }

  /**
   * A second transaction, because the first one is gone: the constraint threw, so
   * the unit of work unwound and rolled it back on the way out. Reading what the
   * send collided with is what makes a retry attach to the answer already being
   * written rather than fail on a question that was accepted.
   */
  private async recall(
    sent: StartGeneration,
    conflict: unknown,
  ): Promise<Result<StartedGeneration, DomainError>> {
    const answer = await this.uow.run(async (ctx) => await replyTo(ctx, sent));
    // Nothing to recall means the row that caused the conflict is not there,
    // which the constraint says cannot happen. Raising the original is better
    // than inventing an answer about a message nobody can find.
    if (answer === null) throw conflict;

    return Ok({ assistantMessageId: answer.id, resumed: true });
  }
}

/**
 * The answer to a question is the message after it, always: both rows are
 * written in one transaction, and a concurrent transaction computing the next
 * sequence number sees only committed rows — so it collides and retries rather
 * than landing between the two. That is what makes `seq + 1` a link rather than
 * a guess, and why no column holds one.
 */
async function replyTo(ctx: TxContext, sent: StartGeneration): Promise<StoredMessage | null> {
  const question = await ctx.messages.findByClientId(sent.conversationId, sent.clientMessageId);
  if (question === null) return null;

  return await ctx.messages.findBySeq(sent.conversationId, question.seq + 1);
}
