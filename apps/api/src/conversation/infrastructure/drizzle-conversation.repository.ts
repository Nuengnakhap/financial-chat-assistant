import type { ConversationId, OwnerScope } from '@fca/domain';
import { and, desc, eq } from 'drizzle-orm';

import type { DbOrTx } from '../../shared/persistence/db-or-tx';
import { conversations } from '../../shared/persistence/schema';
import type {
  ConversationRepository,
  ConversationSummary,
  NewConversation,
} from '../application/ports/conversation.repository';

const COLUMNS = {
  id: conversations.id,
  title: conversations.title,
  state: conversations.state,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
};

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
      .where(and(eq(conversations.id, id), eq(conversations.userId, scope.userId)))
      .limit(1);

    return row === undefined ? null : toSummary(row);
  }

  async listForOwner(scope: OwnerScope, limit: number): Promise<readonly ConversationSummary[]> {
    const rows = await this.db
      .select(COLUMNS)
      .from(conversations)
      .where(eq(conversations.userId, scope.userId))
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(limit);

    return rows.map(toSummary);
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
}

function toSummary(row: {
  id: string;
  title: string;
  state: 'active' | 'deleting';
  createdAt: Date;
  updatedAt: Date;
}): ConversationSummary {
  // The only place a raw column becomes a branded id: the row came from our own
  // database, so the value is known-good.
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  return { ...row, id: row.id as ConversationId };
}
