import type {
  ClientMessageId,
  ConversationId,
  MessageId,
  MessageStatus,
  OwnerScope,
} from '@fca/domain';

import type { MessageCursor, Page, PageRequest } from '../pagination';

export interface MessagePageRequest extends PageRequest<MessageCursor> {
  readonly conversationId: ConversationId;
}

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
  /**
   * A conversation is read from its end: the first page is the newest messages,
   * and paging moves backwards through older ones — which is the direction
   * someone scrolls. Within a page the items are in reading order, oldest
   * first, so a caller never has to know that.
   */
  listForConversation(
    scope: OwnerScope,
    request: MessagePageRequest,
  ): Promise<Page<StoredMessage, MessageCursor>>;
}
