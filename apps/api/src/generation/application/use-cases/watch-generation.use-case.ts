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
import {
  GENERATION_EVENTS,
  type GenerationEvents,
  type StoredStreamEvent,
} from '../ports/generation-events.port';
import { GENERATION_MESSAGES, type GenerationMessages } from '../ports/generation-messages.port';

export interface Watching {
  /** Where the client got to last time. The whole stream when it has seen nothing. */
  readonly afterId: string;
  readonly signal: AbortSignal;
}

/**
 * Watching an answer being written, from wherever the watcher had got to.
 *
 * Attaching for the first time, opening a second tab and coming back after a
 * dropped connection are one operation: the client says what it last saw and is
 * given everything after it. Nothing here knows whether the generation is still
 * running, which is why a finished one needs no special path — its events are
 * still there to be read, ending in the terminal one that tells a client to stop.
 */
@Injectable()
export class WatchGenerationUseCase {
  constructor(
    @Inject(GENERATION_MESSAGES) private readonly messages: GenerationMessages,
    @Inject(GENERATION_EVENTS) private readonly events: GenerationEvents,
  ) {}

  async execute(
    scope: OwnerScope,
    messageId: MessageId,
    watching: Watching,
  ): Promise<Result<AsyncIterable<StoredStreamEvent>, NotFoundError>> {
    const answer = await this.messages.find(messageId);
    // Somebody else's answer is not theirs to watch, and saying so in different
    // words from "there is no such message" would be telling them it exists.
    if (answer?.ownerId !== scope.userId) return Err(answerGone());

    // A generation still running always has a stream; one that ended may have
    // outlived it, and then the row is the only place the answer still is.
    const ended = answer.status !== 'generating';
    if (ended && (await this.events.lastActivityAt(messageId)) === null) {
      return Ok(this.fromTheRow(messageId));
    }

    return Ok(this.events.read(messageId, watching.afterId, watching.signal));
  }

  /**
   * A generation that ended long enough ago for its stream to have expired. The
   * message itself is kept for good, so the answer is still there to be given —
   * and a client that attached expecting one event gets exactly one.
   */
  private async *fromTheRow(messageId: MessageId): AsyncGenerator<StoredStreamEvent> {
    const message = await this.messages.view(messageId);
    if (message === null) return;

    // No id: there is no position in a stream that no longer exists, and a
    // client must not come back asking to resume from one.
    yield { id: null, event: { type: 'message_complete', message } };
  }
}
