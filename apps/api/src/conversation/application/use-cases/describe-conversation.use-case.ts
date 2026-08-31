import { Err, Ok, type NotFoundError, type OwnerScope, type Result } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';
import { conversationGone, requireConversationId } from '../conversation-id';
import type { ConversationSummary } from '../ports/conversation.repository';

@Injectable()
export class DescribeConversationUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * Someone else's conversation answers exactly as one that never existed does,
   * and so does one that is being deleted. The repository is what makes that
   * true — the owner is part of the predicate, not a check that runs after.
   */
  async execute(
    scope: OwnerScope,
    id: string,
  ): Promise<Result<ConversationSummary, NotFoundError>> {
    const named = requireConversationId(id);
    if (!named.ok) return named;

    const found = await this.uow.run(
      async (ctx) => await ctx.conversations.findById(scope, named.value),
    );

    return found === null ? Err(conversationGone()) : Ok(found);
  }
}
