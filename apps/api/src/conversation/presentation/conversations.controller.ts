import {
  conversationsContract,
  type ConversationView,
  type ListConversationsQuery,
} from '@fca/contracts';
import { Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';

import { toConversationView } from './conversation-view';
import { requirePrincipal } from '../../shared/http/request-context';
import { SessionGuard } from '../../shared/http/session.guard';
import { ZodPayload } from '../../shared/http/zod-payload.pipe';
import { CreateConversationUseCase } from '../application/use-cases/create-conversation.use-case';
import { ListConversationsUseCase } from '../application/use-cases/list-conversations.use-case';

const LIST_QUERY = new ZodPayload(conversationsContract.list.query);

interface ConversationsPage {
  readonly items: readonly ConversationView[];
  readonly nextCursor: string | null;
}

/**
 * The collection: what the rail shows, and the button that starts a new
 * conversation. The item routes are next door, because a controller reaches
 * three collaborators before it reaches four.
 */
@Controller()
@UseGuards(SessionGuard)
export class ConversationsController {
  constructor(
    private readonly list: ListConversationsUseCase,
    private readonly create: CreateConversationUseCase,
  ) {}

  @Get(conversationsContract.list.path)
  async listConversations(
    @Query(LIST_QUERY) query: ListConversationsQuery,
  ): Promise<ConversationsPage> {
    const { userId } = requirePrincipal();
    const page = await this.list.execute({ userId }, query);
    // A cursor that has been edited is a request that cannot be answered, not a
    // server fault: the filter turns it into the same 400 any bad field gets.
    if (!page.ok) throw page.error;

    return { items: page.value.items.map(toConversationView), nextCursor: page.value.nextCursor };
  }

  @Post(conversationsContract.create.path)
  @HttpCode(conversationsContract.create.status)
  async createConversation(): Promise<{ conversation: ConversationView }> {
    const { userId } = requirePrincipal();

    return { conversation: toConversationView(await this.create.execute({ userId })) };
  }
}
