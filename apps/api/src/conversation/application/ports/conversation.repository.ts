import type { ConversationId, OwnerScope } from '@fca/domain';

import type { ConversationCursor, Page, PageRequest } from '../pagination';

export interface ConversationSummary {
  readonly id: ConversationId;
  readonly title: string;
  readonly state: 'active' | 'deleting';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewConversation {
  readonly id: ConversationId;
  readonly title: string;
  readonly createdAt: Date;
}

export interface ConversationRepository {
  create(scope: OwnerScope, conversation: NewConversation): Promise<void>;
  findById(scope: OwnerScope, id: ConversationId): Promise<ConversationSummary | null>;
  /**
   * Most recently used first, and only the ones that are still there: a
   * conversation being deleted is left out by the query itself, so no caller
   * can forget to filter it.
   */
  listForOwner(
    scope: OwnerScope,
    request: PageRequest<ConversationCursor>,
  ): Promise<Page<ConversationSummary, ConversationCursor>>;
  /** Returns false when the row is already being deleted, or is not the caller's. */
  markDeleting(scope: OwnerScope, id: ConversationId, now: Date): Promise<boolean>;
}
