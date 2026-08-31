import { conversationsContract, type ConversationView, type Ok } from '@fca/contracts';
import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common';

import { toConversationView } from './conversation-view';
import { requirePrincipal } from '../../shared/http/request-context';
import { SessionGuard } from '../../shared/http/session.guard';
import { DescribeConversationUseCase } from '../application/use-cases/describe-conversation.use-case';
import { RemoveConversationUseCase } from '../application/use-cases/remove-conversation.use-case';

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
    private readonly remove: RemoveConversationUseCase,
  ) {}

  @Get(conversationsContract.get.path)
  async getConversation(@Param('id') id: string): Promise<{ conversation: ConversationView }> {
    const { userId } = requirePrincipal();
    const found = await this.describe.execute({ userId }, id);
    if (!found.ok) throw found.error;

    return { conversation: toConversationView(found.value) };
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
