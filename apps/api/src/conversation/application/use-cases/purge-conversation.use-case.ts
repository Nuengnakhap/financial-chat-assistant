import type { ConversationId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';

@Injectable()
export class PurgeConversationUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * Finishing what `RemoveConversationUseCase` started. It runs from a queue, so
   * it may run again on a conversation it already removed — and that answers
   * `false` rather than throwing, because a job delivered twice is the normal
   * cost of never losing one.
   *
   * Stopping a generation that is still running against the conversation
   * belongs here too, and lands with the generation context: there is nothing
   * to stop yet, and writing a call to something that does not exist would be
   * an untested branch pretending to be a feature.
   */
  async execute(id: ConversationId): Promise<boolean> {
    return await this.uow.run(async (ctx) => await ctx.conversations.purge(id));
  }
}
