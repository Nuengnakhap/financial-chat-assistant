import {
  conversationsContract,
  type ConversationView,
  type ListMessagesQuery,
  type MessageView,
  type Ok,
} from '@fca/contracts';
import { Controller, Delete, Get, HttpCode, Param, Query, UseGuards } from '@nestjs/common';

import { toConversationView } from './conversation-view';
import { toMessageView } from './message-view';
import { requirePrincipal } from '../../shared/http/request-context';
import { SessionGuard } from '../../shared/http/session.guard';
import { ZodPayload } from '../../shared/http/zod-payload.pipe';
import { DescribeConversationUseCase } from '../application/use-cases/describe-conversation.use-case';
import { ListMessagesUseCase } from '../application/use-cases/list-messages.use-case';
import { RemoveConversationUseCase } from '../application/use-cases/remove-conversation.use-case';

const MESSAGES_QUERY = new ZodPayload(conversationsContract.listMessages.query);

interface MessagesPage {
  readonly items: readonly MessageView[];
  readonly nextCursor: string | null;
}

const ACCEPTED: Ok = { ok: true };

/**
 * One conversation: reading it, and asking for it to go. Both answer 404 for an
 * id that is someone else's, already being deleted, or not a UUID at all —
 * decided in the use case, so the wording and the status come from one place.
 */
@Controller()
@UseGuards(SessionGuard)
export class ConversationController {
  constructor(
    private readonly describe: DescribeConversationUseCase,
    private readonly history: ListMessagesUseCase,
    private readonly remove: RemoveConversationUseCase,
  ) {}

  @Get(conversationsContract.get.path)
  async getConversation(@Param('id') id: string): Promise<{ conversation: ConversationView }> {
    const { userId } = requirePrincipal();
    const found = await this.describe.execute({ userId }, id);
    if (!found.ok) throw found.error;

    return { conversation: toConversationView(found.value) };
  }

  @Get(conversationsContract.listMessages.path)
  async listMessages(
    @Param('id') id: string,
    @Query(MESSAGES_QUERY) query: ListMessagesQuery,
  ): Promise<MessagesPage> {
    const { userId } = requirePrincipal();
    const page = await this.history.execute({ userId }, id, query);
    // A conversation that is not the caller's answers 404 here as it does
    // above; a cursor somebody edited is the same 400 any bad field gets.
    if (!page.ok) throw page.error;

    return { items: page.value.items.map(toMessageView), nextCursor: page.value.nextCursor };
  }

  @Delete(conversationsContract.remove.path)
  @HttpCode(conversationsContract.remove.status)
  async removeConversation(@Param('id') id: string): Promise<Ok> {
    const { userId } = requirePrincipal();
    const started = await this.remove.execute({ userId }, id);
    if (!started.ok) throw started.error;

    // 202, not 200: the conversation is gone from every read as of now, and the
    // rows follow. Saying 200 would claim work that has not happened.
    return ACCEPTED;
  }
}
