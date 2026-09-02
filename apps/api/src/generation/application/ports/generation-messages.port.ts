import type { GroundingReport, MessagePart, MessageView } from '@fca/contracts';
import type { ConversationId, MessageId, MessageStatus, UserId } from '@fca/domain';

import type { PastTurn } from '../transcript';

/**
 * The rows a generation needs, in this context's own words.
 *
 * The conversation context owns messages and has a repository of its own; this
 * is deliberately not that one. A bounded context reaching into another's port
 * couples the two so that neither can change alone, so the narrow capability is
 * declared here and implemented next to the schema — the same shape `SessionGuard`
 * takes towards identity's token issuer.
 */

/** The placeholder an answer is being written into. */
export interface Answer {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  /** Who may watch it and who may stop it; never taken from the request. */
  readonly ownerId: UserId;
  readonly seq: number;
  readonly status: MessageStatus;
  readonly startedAt: Date;
}

export interface Question {
  readonly text: string;
  /** Earlier turns, oldest first, already trimmed to what is worth replaying. */
  readonly history: readonly PastTurn[];
}

export interface FinishedAnswer {
  readonly messageId: MessageId;
  /** `generating` is not among them: this is the write that ends one. */
  readonly status: Exclude<MessageStatus, 'generating'>;
  readonly parts: readonly MessagePart[];
  readonly verification: GroundingReport | null;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface GenerationMessages {
  find(messageId: MessageId): Promise<Answer | null>;
  /**
   * What was asked, and what was said before it. Null when the row before this
   * one is not a question, which means the placeholder was written by something
   * other than the command that pairs the two.
   */
  questionFor(answer: Answer): Promise<Question | null>;
  /**
   * Conditional on the row still being `generating`, so the first writer wins
   * and a stop arriving as an answer is persisted cannot produce two endings.
   * Null when somebody else got there first.
   */
  finish(answer: FinishedAnswer): Promise<MessageView | null>;
  /**
   * The whole message as a client reads it. Separate from `find` because that
   * one answers a question about a generation and this one answers with an
   * answer — most callers need only the first, and it is far the cheaper read.
   */
  view(messageId: MessageId): Promise<MessageView | null>;
  /** Still `generating` long after anything could still be writing them. */
  listAbandoned(startedBefore: Date): Promise<readonly Answer[]>;
}

export const GENERATION_MESSAGES = Symbol('GenerationMessages');
