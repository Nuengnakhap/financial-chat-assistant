import type { ConversationId, UserId } from '@fca/domain';

/**
 * Ownership is a parameter, not a caller's responsibility to remember. Every
 * method takes a scope and every query filters on it, so "list someone else's
 * conversations" is not a call that can be written.
 */
export interface OwnerScope {
  readonly userId: UserId;
}

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
  listForOwner(scope: OwnerScope, limit: number): Promise<readonly ConversationSummary[]>;
  /** Returns false when the row is already being deleted, or is not the caller's. */
  markDeleting(scope: OwnerScope, id: ConversationId, now: Date): Promise<boolean>;
}
