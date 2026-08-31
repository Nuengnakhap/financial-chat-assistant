import { Err, Ok, type NotFoundError, type OwnerScope, type Result } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';
import { conversationGone, requireConversationId } from '../conversation-id';

@Injectable()
export class RemoveConversationUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * The request does two things and no more: it makes the conversation
   * invisible, and it records that someone asked for it to go. Both in one
   * transaction, so there is no moment where a conversation has disappeared and
   * nothing has been told to finish the job — nor one where a worker is asked
   * to delete a conversation that is still there because the transaction rolled
   * back after the enqueue.
   *
   * The rows themselves go later. A conversation may have a generation running
   * against it, and stopping that crosses Redis and a queue; it also has to
   * survive being retried, which one HTTP request cannot offer.
   */
  async execute(
    scope: OwnerScope,
    id: string,
    now = new Date(),
  ): Promise<Result<void, NotFoundError>> {
    const named = requireConversationId(id);
    if (!named.ok) return named;

    const started = await this.uow.run(async (ctx) => {
      const marked = await ctx.conversations.markDeleting(scope, named.value, now);
      // Only the first request publishes. `markDeleting` is conditional on the
      // conversation still being active, so two clicks cannot ask twice.
      if (marked) {
        ctx.publish({
          aggregate: 'conversation',
          aggregateId: named.value,
          type: 'conversation.delete_requested',
          // The id is the whole message: what the worker has to do is decided
          // by the type, and everything it needs to do it is the aggregate.
          payload: {},
        });
      }
      return marked;
    });

    // Deleting one already being deleted answers as one that is gone, which it
    // is — the same answer as someone else's, for the same reason.
    return started ? Ok(undefined) : Err(conversationGone());
  }
}
