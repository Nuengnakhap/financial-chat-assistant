import type { ConversationId, OwnerScope } from '@fca/domain';

import type { ConversationCursor, Page, PageRequest } from '../pagination';

export interface ConversationSummary {
  readonly id: ConversationId;
  readonly title: string;
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
  /**
   * `null` for a conversation that is not there, is not the caller's, or is on
   * its way out. There is no state on the summary to check afterwards, because
   * a check a caller can forget is one a caller will forget.
   */
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
  /**
   * Removes a conversation that was marked for deletion, and its messages with
   * it. No `OwnerScope`, because the caller is the system finishing work an
   * owner already asked for — and `deleting` is what stands in for the check:
   * only `markDeleting` puts a row in that state, and only after the owner was
   * verified, so a conversation somebody is still using cannot be destroyed
   * here however the id arrived.
   *
   * False when there was nothing to remove, which is the ordinary answer to a
   * job delivered twice rather than a failure.
   */
  purge(id: ConversationId): Promise<boolean>;
}
