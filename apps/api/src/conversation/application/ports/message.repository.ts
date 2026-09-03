import type { GroundingReport } from '@fca/contracts';
import type {
  ClientMessageId,
  ConversationId,
  MessageId,
  MessageStatus,
  OwnerScope,
  Reservation,
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
  /**
   * The claim on the asker's budget that this answer will be charged against.
   * Written with the row rather than after it, so no generation can exist for a
   * moment without the thing that has to be given back when it ends.
   */
  readonly reservation?: Reservation | undefined;
}

export interface StoredMessage {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly seq: number;
  readonly role: 'user' | 'assistant';
  readonly status: MessageStatus;
  readonly parts: readonly unknown[];
  /**
   * Present exactly when an assistant message is `complete` — the pairing that
   * `chk_complete_has_verification` holds, carried up so a caller reads it
   * rather than reconstructing it.
   */
  readonly verification: GroundingReport | null;
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
   * The row a duplicate `clientMessageId` collided with. `null` when the send
   * is the first of its kind — which is the ordinary case, and why the read
   * happens on the way out of a conflict rather than before every write.
   */
  findByClientId(
    conversationId: ConversationId,
    clientMessageId: ClientMessageId,
  ): Promise<StoredMessage | null>;
  /**
   * A position within a conversation, which is the only link between a question
   * and the answer written for it: the two are appended in one transaction, so
   * the answer is always the message after the question and nothing can land
   * between them.
   */
  findBySeq(conversationId: ConversationId, seq: number): Promise<StoredMessage | null>;
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
