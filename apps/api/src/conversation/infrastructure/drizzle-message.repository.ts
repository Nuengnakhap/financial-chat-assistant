import type { ConversationId, MessageId, MessageStatus, OwnerScope } from '@fca/domain';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { DbOrTx } from '../../shared/persistence/db-or-tx';
import { isUniqueViolationOf } from '../../shared/persistence/pg-errors';
import { conversations, messages } from '../../shared/persistence/schema';
import type {
  AppendMessage,
  MessageRepository,
  StoredMessage,
} from '../application/ports/message.repository';

interface MessageColumns {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  status: MessageStatus;
  parts: unknown;
  createdAt: Date;
}

/** Bounded: one attempt per writer that could plausibly be racing this one. */
const MAX_APPEND_ATTEMPTS = 10;

const COLUMNS = {
  id: messages.id,
  conversationId: messages.conversationId,
  seq: messages.seq,
  role: messages.role,
  status: messages.status,
  parts: messages.parts,
  createdAt: messages.createdAt,
};

export class DrizzleMessageRepository implements MessageRepository {
  constructor(private readonly db: DbOrTx) {}

  async append(message: AppendMessage): Promise<StoredMessage> {
    return await this.appendAttempt(message, 1);
  }

  /**
   * Computing the next sequence number inside the INSERT keeps the read and the
   * write in one statement, but it does not serialise across transactions: under
   * read committed, two concurrent appends both see the same committed maximum
   * and the second to commit loses to `uq_message_seq`. Measured, not assumed —
   * eight concurrent appends produced three rejections before this retry existed.
   *
   * So the constraint is what guarantees correctness and the retry is what
   * absorbs the collision. Only that constraint is retried: a clash on the
   * client message id means the caller sent the same message twice, which is the
   * idempotency rule working and has to reach them.
   */
  private async appendAttempt(message: AppendMessage, attempt: number): Promise<StoredMessage> {
    try {
      const [row] = await this.db
        .insert(messages)
        .values({
          conversationId: message.conversationId,
          clientMessageId: message.clientMessageId,
          role: message.role,
          parts: message.parts,
          status: message.status,
          seq: sql`(SELECT COALESCE(MAX(${messages.seq}), 0) + 1 FROM ${messages} WHERE ${messages.conversationId} = ${message.conversationId})`,
        })
        .returning(COLUMNS);

      if (row === undefined) throw new Error('insert returned no row');
      return toStored(row);
    } catch (error) {
      if (attempt >= MAX_APPEND_ATTEMPTS || !isUniqueViolationOf(error, 'uq_message_seq'))
        throw error;
      return await this.appendAttempt(message, attempt + 1);
    }
  }

  async listForConversation(
    scope: OwnerScope,
    conversationId: ConversationId,
    limit: number,
  ): Promise<readonly StoredMessage[]> {
    // Joined rather than checked in two queries: ownership and selection are one
    // predicate, so there is no window between them and no second round trip.
    const rows = await this.db
      .select(COLUMNS)
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(eq(messages.conversationId, conversationId), eq(conversations.userId, scope.userId)),
      )
      .orderBy(asc(messages.seq))
      .limit(limit);

    return rows.map(toStored);
  }
}

function toStored(row: MessageColumns): StoredMessage {
  /* eslint-disable @typescript-eslint/consistent-type-assertions */
  return {
    ...row,
    id: row.id as MessageId,
    conversationId: row.conversationId as ConversationId,
    parts: Array.isArray(row.parts) ? (row.parts as readonly unknown[]) : [],
  };
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
}
