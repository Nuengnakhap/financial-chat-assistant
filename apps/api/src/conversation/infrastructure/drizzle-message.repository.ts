import type {
  ClientMessageId,
  ConversationId,
  MessageId,
  MessageStatus,
  OwnerScope,
} from '@fca/domain';
import { and, desc, eq, lt, sql } from 'drizzle-orm';

import { delay } from '../../shared/async/timeouts';
import type { DbOrTx } from '../../shared/persistence/db-or-tx';
import { isUniqueViolationOf } from '../../shared/persistence/pg-errors';
import { conversations, messages } from '../../shared/persistence/schema';
import { readVerification } from '../../shared/persistence/stored-json';
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
  verification: unknown;
  createdAt: Date;
}

/** Bounded: one attempt per writer that could plausibly be racing this one. */
const MAX_APPEND_ATTEMPTS = 10;

/**
 * Retrying the instant a collision is reported sends every loser back into the
 * same instant, so the same writer loses again — measured, not feared: a
 * hundred concurrent appends lost seven to ten of them that way, with every
 * stored sequence still gapless, so the symptom was work missing rather than
 * work wrong. A random wait before each retry, scaled by how many times this
 * writer has already lost, spreads them apart instead.
 *
 * Thirty rather than ten because the wait has to outlast the contention it is
 * waiting out: a hundred writers through a pool of ten hold their transactions
 * far longer than the same hundred appends did on their own, and ten was
 * measurably not enough — one write in a hundred still exhausted its attempts.
 * At thirty, eight runs of fifty and a hundred were rejected zero times.
 */
const RETRY_SPREAD_MS = 30;

const COLUMNS = {
  id: messages.id,
  conversationId: messages.conversationId,
  seq: messages.seq,
  role: messages.role,
  status: messages.status,
  parts: messages.parts,
  verification: messages.verification,
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
      // Each attempt gets a scope of its own. A unique violation aborts the
      // transaction it fires in and PostgreSQL then refuses every statement
      // until that transaction ends — so a retry issued in the same scope
      // answers `current transaction is aborted` rather than trying again.
      // Nested inside a caller's transaction this is a SAVEPOINT, which rolls
      // back the failed attempt and leaves everything before it standing.
      return await this.db.transaction(async (scoped) => await insertOnce(scoped, message));
    } catch (error) {
      if (attempt >= MAX_APPEND_ATTEMPTS || !isUniqueViolationOf(error, 'uq_message_seq'))
        throw error;

      await delay(Math.random() * RETRY_SPREAD_MS * attempt);
      return await this.appendAttempt(message, attempt + 1);
    }
  }

  /**
   * No `OwnerScope`: the caller reaches this only after `findById` has proved
   * the conversation is theirs, and a client message id is meaningless outside
   * the conversation it was sent to. The pair is what `uq_message_client_id`
   * is built on, so this reads back exactly the row that constraint rejected.
   */
  async findByClientId(
    conversationId: ConversationId,
    clientMessageId: ClientMessageId,
  ): Promise<StoredMessage | null> {
    const [row] = await this.db
      .select(COLUMNS)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.clientMessageId, clientMessageId),
        ),
      )
      .limit(1);

    return row === undefined ? null : toStored(row);
  }

  /**
   * No `OwnerScope` either, and for the same reason: a position is meaningless
   * outside the conversation it counts within, which the caller has already
   * proved is theirs.
   */
  async findBySeq(conversationId: ConversationId, seq: number): Promise<StoredMessage | null> {
    const [row] = await this.db
      .select(COLUMNS)
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.seq, seq)))
      .limit(1);

    return row === undefined ? null : toStored(row);
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

async function insertOnce(db: DbOrTx, message: AppendMessage): Promise<StoredMessage> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: message.conversationId,
      clientMessageId: message.clientMessageId,
      role: message.role,
      parts: message.parts,
      status: message.status,
      // Both halves or neither, which `chk_reservation_is_whole` insists on:
      // half a claim cannot be given back, and the half that would be missing
      // is the one that says which window to give it back to.
      reservationId: message.reservation?.id ?? null,
      reservationWindow: message.reservation?.windowStart ?? null,
      seq: sql`(SELECT COALESCE(MAX(${messages.seq}), 0) + 1 FROM ${messages} WHERE ${messages.conversationId} = ${message.conversationId})`,
    })
    .returning(COLUMNS);

  if (row === undefined) throw new Error('insert returned no row');

  return toStored(row);
}

function toStored(row: MessageColumns): StoredMessage {
  /* eslint-disable @typescript-eslint/consistent-type-assertions */
  return {
    ...row,
    id: row.id as MessageId,
    conversationId: row.conversationId as ConversationId,
    parts: Array.isArray(row.parts) ? (row.parts as readonly unknown[]) : [],
    // Parsed rather than asserted: this column is `jsonb`, so its type is a
    // claim about what was written rather than something the row can prove. A
    // report that does not parse is not a report, and rendering half of one is
    // how an answer would look verified without being it.
    verification: readVerification(row.verification),
  };
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
}
