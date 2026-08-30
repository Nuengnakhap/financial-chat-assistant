import type {
  ClientMessageId,
  ConversationId,
  MessageId,
  MessageStatus,
  OwnerScope,
} from '@fca/domain';

export interface AppendMessage {
  readonly conversationId: ConversationId;
  readonly clientMessageId: ClientMessageId | null;
  readonly role: 'user' | 'assistant';
  readonly parts: readonly unknown[];
  readonly status: MessageStatus;
}

export interface StoredMessage {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly seq: number;
  readonly role: 'user' | 'assistant';
  readonly status: MessageStatus;
  readonly parts: readonly unknown[];
  readonly createdAt: Date;
}

export interface MessageRepository {
  /**
   * Concurrent sends to one conversation are safe: a unique constraint rejects a
   * duplicate position and the adapter retries, so no message is lost. Ordering
   * between simultaneous sends is whatever the database settles on.
   */
  append(message: AppendMessage): Promise<StoredMessage>;
  listForConversation(
    scope: OwnerScope,
    conversationId: ConversationId,
    limit: number,
  ): Promise<readonly StoredMessage[]>;
}
