import type { ConversationId, OwnerScope } from '@fca/domain';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import type { DbOrTx } from '../../shared/persistence/db-or-tx';
import { conversations } from '../../shared/persistence/schema';
import {
  pageOf,
  type ConversationCursor,
  type Page,
  type PageRequest,
} from '../application/pagination';
import type {
  ConversationRepository,
  ConversationSummary,
  NewConversation,
} from '../application/ports/conversation.repository';

const COLUMNS = {
  id: conversations.id,
  title: conversations.title,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
};

/**
 * The one clause that makes a conversation on its way out answer as one that
 * never existed. Written once and applied by every read, so it is not a rule a
 * use case has to remember — and it is why `ConversationSummary` carries no
 * state for anyone to forget to check.
 */
const VISIBLE = eq(conversations.state, 'active');

export class DrizzleConversationRepository implements ConversationRepository {
  constructor(private readonly db: DbOrTx) {}

  async create(scope: OwnerScope, conversation: NewConversation): Promise<void> {
    await this.db.insert(conversations).values({
      id: conversation.id,
      userId: scope.userId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.createdAt,
    });
  }

  async findById(scope: OwnerScope, id: ConversationId): Promise<ConversationSummary | null> {
    // The owner is part of the predicate, not checked afterwards: a row that is
    // not yours is indistinguishable from one that does not exist.
    const [row] = await this.db
      .select(COLUMNS)
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, scope.userId), VISIBLE))
      .limit(1);

    return row === undefined ? null : toSummary(row);
  }

  async listForOwner(
    scope: OwnerScope,
    request: PageRequest<ConversationCursor>,
  ): Promise<Page<ConversationSummary, ConversationCursor>> {
    const rows = await conversationPageQuery(this.db, scope, request);

    return pageOf(rows.map(toSummary), request, (row) => ({
      updatedAt: row.updatedAt,
      id: row.id,
    }));
  }

  async markDeleting(scope: OwnerScope, id: ConversationId, now: Date): Promise<boolean> {
    // Conditional on the current state, so two concurrent deletes cannot both
    // start a pipeline for the same conversation.
    const updated = await this.db
      .update(conversations)
      .set({ state: 'deleting', updatedAt: now })
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.userId, scope.userId),
          eq(conversations.state, 'active'),
        ),
      )
      .returning({ id: conversations.id });

    return updated.length === 1;
  }

  async purge(id: ConversationId): Promise<boolean> {
    // `state = 'deleting'` is part of the predicate rather than something read
    // first and checked: between a read and a delete the row could have changed,
    // and there is no scope here to fall back on.
    const removed = await this.db
      .delete(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.state, 'deleting')))
      .returning({ id: conversations.id });

    return removed.length === 1;
  }
}

/**
 * Exported so the integration test can `EXPLAIN` the statement the repository
 * actually runs rather than a copy of it written in the test, which is the copy
 * that stops matching first.
 */
export function conversationPageQuery(
  db: DbOrTx,
  scope: OwnerScope,
  request: PageRequest<ConversationCursor>,
) {
  return (
    db
      .select(COLUMNS)
      .from(conversations)
      .where(and(eq(conversations.userId, scope.userId), VISIBLE, further(request.cursor)))
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      // One more than asked for. See `pageOf`.
      .limit(request.limit + 1)
  );
}

/**
 * A row comparison rather than `updated_at < $1 OR (updated_at = $1 AND id <
 * $2)`. The planner turns this form into an index condition on
 * `idx_conversations_owner_recent`, which the plan test asserts — the same
 * scan, backwards, that the unpaged first page uses.
 */
function further(cursor: ConversationCursor | null): SQL | undefined {
  if (cursor === null) return undefined;

  return sql`(${conversations.updatedAt}, ${conversations.id}) < (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`;
}

function toSummary(row: {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}): ConversationSummary {
  // The only place a raw column becomes a branded id: the row came from our own
  // database, so the value is known-good.
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  return { ...row, id: row.id as ConversationId };
}
