import {
  messagesContract,
  type StartGenerationBody,
  type StartGenerationResponse,
} from '@fca/contracts';
import { ClientMessageId } from '@fca/domain';
import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { requirePrincipal } from '../../shared/http/request-context';
import { SessionGuard } from '../../shared/http/session.guard';
import { ZodPayload } from '../../shared/http/zod-payload.pipe';
import { requireConversationId } from '../application/conversation-id';
import { StartGenerationUseCase } from '../application/use-cases/start-generation.use-case';

/**
 * Asking a question. It answers 202 and a path, never an answer: the generation
 * outlives this request, and what the client does next is attach to the stream
 * the path names — including after a refresh, a new tab, or a different device.
 */
@Controller()
@UseGuards(SessionGuard)
export class MessagesController {
  constructor(private readonly start: StartGenerationUseCase) {}

  @Post(messagesContract.startGeneration.path)
  @HttpCode(messagesContract.startGeneration.status)
  async startGeneration(
    @Param('id') id: string,
    // Built once, when the class is defined — a decorator argument is evaluated
    // then, not per request.
    @Body(new ZodPayload(messagesContract.startGeneration.body)) body: StartGenerationBody,
  ): Promise<StartGenerationResponse> {
    const { userId } = requirePrincipal();
    const conversationId = requireConversationId(id);
    if (!conversationId.ok) throw conversationId.error;

    const started = await this.start.execute(
      { userId },
      {
        conversationId: conversationId.value,
        // Trusted rather than parsed: the body schema has already established
        // that this is a UUID, and parsing it twice would give two answers to
        // one question about the same string.
        clientMessageId: ClientMessageId.trusted(body.clientMessageId),
        content: body.content,
      },
    );
    if (!started.ok) throw started.error;

    return {
      assistantMessageId: started.value.assistantMessageId,
      // Built from the contract rather than written out, so the path a client is
      // sent to and the path it can call are the same string by construction.
      streamPath: messagesContract.stream.path.replace(':id', started.value.assistantMessageId),
      resumed: started.value.resumed,
    };
  }
}
