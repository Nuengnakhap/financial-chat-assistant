import type { ListMessagesQuery } from '@fca/contracts';
import { Err, Ok, type DomainError, type OwnerScope, type Result } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';
import { conversationGone, requireConversationId } from '../conversation-id';
import { messageCursor, type MessageCursor } from '../pagination';
import type { StoredMessage } from '../ports/message.repository';

export interface MessagePage {
  readonly items: readonly StoredMessage[];
  /** Opaque, and `null` at the start of the conversation. */
  readonly nextCursor: string | null;
}

@Injectable()
export class ListMessagesUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * The conversation is looked up first so that a page of nothing and a
   * conversation that is not the caller's are different answers. Without it,
   * asking for someone else's history would return an empty page — which reads
   * like an empty conversation and tells the asker their id was real.
   */
  async execute(
    scope: OwnerScope,
    id: string,
    query: ListMessagesQuery,
  ): Promise<Result<MessagePage, DomainError>> {
    const named = requireConversationId(id);
    if (!named.ok) return named;

    const from = positionFrom(query.cursor);
    if (!from.ok) return from;

    const page = await this.uow.run(async (ctx) => {
      const conversation = await ctx.conversations.findById(scope, named.value);
      if (conversation === null) return null;

      return await ctx.messages.listForConversation(scope, {
        conversationId: named.value,
        limit: query.limit,
        cursor: from.value,
      });
    });
    if (page === null) return Err(conversationGone());

    return Ok({
      items: page.items,
      nextCursor: page.nextCursor === null ? null : messageCursor.encode(page.nextCursor),
    });
  }
}

/** No cursor means the end of the conversation, which is where it is opened. */
function positionFrom(raw: string | undefined): Result<MessageCursor | null, DomainError> {
  return raw === undefined ? Ok(null) : messageCursor.decode(raw);
}
