import {
  Err,
  Ok,
  type MessageId,
  type NotFoundError,
  type OwnerScope,
  type Result,
} from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { answerGone } from '../answer-id';
import { GENERATION_MESSAGES, type GenerationMessages } from '../ports/generation-messages.port';
import { GENERATION_STOPS, type GenerationStops } from '../ports/generation-stops.port';

/**
 * Asking for an answer to stop being written.
 *
 * The only thing that ends a generation early. Closing the tab does not, and
 * that is the point of the whole durable stream: a connection going away says
 * something about the connection, and this says something about the answer.
 *
 * It answers 202 either way and does not wait. What it asks for reaches whatever
 * process is generating, which may be another one, and that process is the one
 * that decides what has been written and stores it — so a stop that arrives a
 * moment too late changes nothing, which is what "too late" means.
 */
@Injectable()
export class StopGenerationUseCase {
  constructor(
    @Inject(GENERATION_MESSAGES) private readonly messages: GenerationMessages,
    @Inject(GENERATION_STOPS) private readonly stops: GenerationStops,
  ) {}

  async execute(scope: OwnerScope, messageId: MessageId): Promise<Result<void, NotFoundError>> {
    const answer = await this.messages.find(messageId);
    if (answer?.ownerId !== scope.userId) return Err(answerGone());

    // A finished generation is not an error to stop: whoever asked wanted it to
    // not be running, and it is not running. Saying so with a failure would make
    // a client handle a race it cannot win and does not need to.
    if (answer.status === 'generating') await this.stops.request(messageId);

    return Ok(undefined);
  }
}
