import type { ConversationId, OwnerScope } from '@fca/domain';

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
