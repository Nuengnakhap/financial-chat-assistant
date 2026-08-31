import type { ConversationId, MessageId, MessageStatus, OwnerScope } from '@fca/domain';
import { and, desc, eq, lt, sql } from 'drizzle-orm';

import type { DbOrTx } from '../../shared/persistence/db-or-tx';
import { isUniqueViolationOf } from '../../shared/persistence/pg-errors';
import { conversations, messages } from '../../shared/persistence/schema';
import { pageOf, type MessageCursor, type Page } from '../application/pagination';
import type {
  AppendMessage,
  MessagePageRequest,
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
    request: MessagePageRequest,
  ): Promise<Page<StoredMessage, MessageCursor>> {
    const rows = await messagePageQuery(this.db, scope, request);

    // The query reads newest first, because that is the end a conversation is
    // opened at and the direction paging moves. `pageOf` therefore takes the
    // cursor from the oldest row kept — and only then is the page turned round,
    // so what a caller receives reads downwards like a transcript.
    const page = pageOf(rows.map(toStored), request, (row) => ({ seq: row.seq }));

    return { items: [...page.items].reverse(), nextCursor: page.nextCursor };
  }
}

/** Exported for the same reason as `conversationPageQuery`: the plan is a test. */
export function messagePageQuery(db: DbOrTx, scope: OwnerScope, request: MessagePageRequest) {
  return (
    db
      .select(COLUMNS)
      .from(messages)
      // Joined rather than checked in two queries: ownership and selection are
      // one predicate, so there is no window between them and no second round
      // trip. A conversation being deleted answers as one that never existed.
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(messages.conversationId, request.conversationId),
          eq(conversations.userId, scope.userId),
          eq(conversations.state, 'active'),
          request.cursor === null ? undefined : lt(messages.seq, request.cursor.seq),
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(request.limit + 1)
  );
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
