import { randomUUID } from 'node:crypto';

import { ConversationId, type OwnerScope } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';
import type { ConversationSummary } from '../ports/conversation.repository';

/**
 * What a conversation is called before anyone has said anything in it. The
 * first message replaces it; a conversation nobody types into keeps this, which
 * is honest about what it is.
 */
const UNTITLED = 'New chat';

@Injectable()
export class CreateConversationUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * No event is published. Nothing else in the system has work to do because a
   * conversation exists — the outbox is for a change that has to reach
   * somewhere, and an event with no consumer is a queue that only grows.
   */
  async execute(scope: OwnerScope, now = new Date()): Promise<ConversationSummary> {
    const created = { id: ConversationId.trusted(randomUUID()), title: UNTITLED, createdAt: now };

    await this.uow.run(async (ctx) => {
      await ctx.conversations.create(scope, created);
    });

    // Returned from what was written rather than read back: the row is exactly
    // this, and a second query to learn it would be a round trip that can only
    // agree.
    return { ...created, updatedAt: now };
  }
}
