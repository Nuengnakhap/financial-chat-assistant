import type { DomainEvent } from '@fca/domain';

import type { ConversationRepository } from '../../conversation/application/ports/conversation.repository';
import type { MessageRepository } from '../../conversation/application/ports/message.repository';
import type { SessionRepository } from '../../identity/application/ports/session.repository';

/**
 * The single transaction boundary. A use case that changes state and has to tell
 * something else about it does both here, or neither happens — the alternative,
 * writing the row and then enqueueing, has a window where a crash leaves a
 * message nobody will ever generate, or a job for a message that was rolled back.
 */
export interface TxContext {
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly sessions: SessionRepository;
  /** Buffered, then written to the outbox inside the same transaction. */
  publish(event: DomainEvent): void;
}

export interface UnitOfWork {
  run<T>(work: (ctx: TxContext) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
