import {
  Err,
  Ok,
  titleFromMessage,
  type ClientMessageId,
  type ConversationId,
  type NotFoundError,
  type OwnerScope,
  type Result,
} from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import {
  isForeignKeyViolationOf,
  isUniqueViolationOf,
} from '../../../shared/persistence/pg-errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';
import { conversationGone } from '../conversation-id';
import type { StoredMessage } from '../ports/message.repository';

export interface AppendedMessage {
  readonly message: StoredMessage;
  /** False when this send has been seen before, so a caller does not start the work twice. */
  readonly created: boolean;
}

export interface UserMessage {
  readonly conversationId: ConversationId;
  readonly clientMessageId: ClientMessageId;
  readonly content: string;
}

/** The first message in a conversation is the one that names it. */
const FIRST = 1;

/**
 * The conversation was there when it was read and gone when it was written to,
 * which the delete pipeline can do between two statements of this transaction.
 * The caller asked to write into something that no longer exists, and that is
 * the same answer as asking to write into somebody else's.
 */
const CONVERSATION_FK = 'messages_conversation_id_conversations_id_fk';

@Injectable()
export class AppendUserMessageUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * Writing what somebody sent, once, however many times they send it.
   *
   * There is no read before the write. Two requests carrying the same id can
   * both find nothing and both proceed, so checking first would narrow the
   * window rather than close it — `uq_message_client_id` is what closes it, and
   * the read that matters happens after the constraint has spoken.
   */
  async execute(
    scope: OwnerScope,
    sent: UserMessage,
  ): Promise<Result<AppendedMessage, NotFoundError>> {
    try {
      return await this.write(scope, sent);
    } catch (error) {
      if (isForeignKeyViolationOf(error, CONVERSATION_FK)) return Err(conversationGone());
      if (!isUniqueViolationOf(error, 'uq_message_client_id')) throw error;

      return await this.recall(sent, error);
    }
  }

  private async write(
    scope: OwnerScope,
    sent: UserMessage,
  ): Promise<Result<AppendedMessage, NotFoundError>> {
    return await this.uow.run(async (ctx) => {
      const conversation = await ctx.conversations.findById(scope, sent.conversationId);
      if (conversation === null) return Err(conversationGone());

      const message = await ctx.messages.append({
        conversationId: sent.conversationId,
        clientMessageId: sent.clientMessageId,
        role: 'user',
        parts: [{ kind: 'text', text: sent.content }],
        status: 'complete',
      });

      // Named and reordered in the same transaction as the message. A title
      // written afterwards is a title a crash can leave describing a message
      // that was rolled back.
      await ctx.conversations.touch(scope, {
        id: sent.conversationId,
        at: message.createdAt,
        title: message.seq === FIRST ? titleFromMessage(sent.content) : null,
      });

      return Ok({ message, created: true });
    });
  }

  /**
   * A second transaction, because the first one is gone: the constraint threw,
   * so the unit of work unwound and rolled it back on the way out. Reading the
   * row the send collided with is what makes a retry answer with the same
   * message rather than an error the caller has no way to act on.
   */
  private async recall(
    sent: UserMessage,
    conflict: unknown,
  ): Promise<Result<AppendedMessage, NotFoundError>> {
    const stored = await this.uow.run(
      async (ctx) => await ctx.messages.findByClientId(sent.conversationId, sent.clientMessageId),
    );
    // Nothing to recall means the row that caused the conflict is not there,
    // which the constraint says cannot happen. Raising the original is better
    // than inventing an answer about a message nobody can find.
    if (stored === null) throw conflict;

    return Ok({ message: stored, created: false });
  }
}
