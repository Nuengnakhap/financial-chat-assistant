import type { ListConversationsQuery } from '@fca/contracts';
import { Ok, type OwnerScope, type Result, type ValidationError } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';
import { conversationCursor, type ConversationCursor } from '../pagination';
import type { ConversationSummary } from '../ports/conversation.repository';

export interface ConversationPage {
  readonly items: readonly ConversationSummary[];
  /** Opaque, and `null` at the end of the list. */
  readonly nextCursor: string | null;
}

@Injectable()
export class ListConversationsUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * The cursor is decoded here rather than at the edge, because it is the only
   * layer that knows what a position in this list is made of. A controller
   * handling one would be a second place that has to be kept in step with the
   * keyset.
   */
  async execute(
    scope: OwnerScope,
    query: ListConversationsQuery,
  ): Promise<Result<ConversationPage, ValidationError>> {
    const from = positionFrom(query.cursor);
    if (!from.ok) return from;

    const page = await this.uow.run(
      async (ctx) =>
        await ctx.conversations.listForOwner(scope, { limit: query.limit, cursor: from.value }),
    );

    return Ok({
      items: page.items,
      nextCursor: page.nextCursor === null ? null : conversationCursor.encode(page.nextCursor),
    });
  }
}

/** No cursor is the first page, which is a position too — just not one anyone had to send. */
function positionFrom(raw: string | undefined): Result<ConversationCursor | null, ValidationError> {
  return raw === undefined ? Ok(null) : conversationCursor.decode(raw);
}
