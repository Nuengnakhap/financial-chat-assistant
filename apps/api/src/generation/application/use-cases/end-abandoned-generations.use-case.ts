import type { MessagePart, StreamEvent } from '@fca/contracts';
import type { MessageId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import {
  GENERATION_EVENTS,
  type GenerationEvents,
  type StoredStreamEvent,
} from '../ports/generation-events.port';
import {
  GENERATION_MESSAGES,
  type Answer,
  type GenerationMessages,
} from '../ports/generation-messages.port';

/**
 * The invariant nothing else can hold: no message stays `generating`.
 *
 * Everything above this cleans up after itself. What none of it can do is clean
 * up after a process that stopped existing — a pod killed mid-answer leaves a
 * row saying an answer is being written by nobody, and because at most one
 * generation runs per conversation, that row makes the conversation unusable for
 * good rather than merely leaving a mess behind.
 *
 * Being alive is not asked of the process, which cannot answer once it is gone.
 * It is read off the stream: a generation that is running is producing events,
 * and one that has produced nothing for two minutes has stopped, whether its
 * process died, wedged, or lost the model endpoint.
 */

/**
 * Comfortably longer than the slowest gap a healthy generation has between two
 * events — a first token takes four to five seconds against the configured
 * endpoint, and a tool round about the same — and short enough that somebody
 * whose pod died can ask again while still looking at the screen.
 */
const SILENT_FOR_MS = 120_000;

@Injectable()
export class EndAbandonedGenerationsUseCase {
  constructor(
    @Inject(GENERATION_MESSAGES) private readonly messages: GenerationMessages,
    @Inject(GENERATION_EVENTS) private readonly events: GenerationEvents,
  ) {}

  /** The generations it ended, so the caller can say which rather than how many. */
  async execute(now: Date): Promise<readonly MessageId[]> {
    const silentSince = new Date(now.getTime() - SILENT_FOR_MS);
    const ended: MessageId[] = [];

    /* eslint-disable no-await-in-loop -- one row at a time on purpose: a sweep
       runs beside live traffic, and firing every read and write at once would
       be a burst of load caused by a failure that has already happened. */
    for (const answer of await this.messages.listAbandoned(silentSince)) {
      if (await this.isStillWriting(answer, silentSince)) continue;
      if (await this.end(answer)) ended.push(answer.id);
    }
    /* eslint-enable no-await-in-loop */

    return ended;
  }

  /**
   * A row can be far older than the cutoff and perfectly healthy — a long answer
   * with several tool rounds is minutes of work. What it cannot be is silent.
   */
  private async isStillWriting(answer: Answer, silentSince: Date): Promise<boolean> {
    const lastSeen = (await this.events.lastActivityAt(answer.id)) ?? answer.startedAt;

    return lastSeen > silentSince;
  }

  /**
   * Ended as `stopped` rather than as an error, keeping whatever reached the
   * stream: from where the person sits it is an answer that stopped partway,
   * which is exactly what they watched happen.
   */
  private async end(answer: Answer): Promise<boolean> {
    const seen = await this.events.replay(answer.id);
    const stored = await this.messages.finish({
      messageId: answer.id,
      status: 'stopped',
      parts: partsOf(seen),
      verification: null,
      model: '',
      inputTokens: 0,
      outputTokens: 0,
    });
    // Null means the runner was alive after all and finished between the two
    // reads. It has written its own terminal event, and a second one would be a
    // second ending for one generation.
    if (stored === null) return false;

    await this.events.append(answer.id, { type: 'message_complete', message: stored });

    return true;
  }
}

/**
 * What the person saw, rebuilt from what they were sent. The text comes from the
 * deltas because there is no verified draft to take it from — nothing checked
 * this answer, which is why it is not being stored as `complete`.
 */
function partsOf(seen: readonly StoredStreamEvent[]): readonly MessagePart[] {
  const parts: MessagePart[] = [];
  let text = '';

  for (const { event } of seen) {
    if (event.type === 'text_delta') text += event.delta;
    // The draft that text belonged to was thrown away, and the screen it was on
    // was cleared. Storing it would put back what the reader was told to forget.
    else if (event.type === 'draft_reset') text = '';
    else if (isPart(event)) parts.push(toPart(event));
  }

  return text === '' ? parts : [...parts, { kind: 'text', text }];
}

type PartEvent = Extract<StreamEvent, { type: 'tool_call_ready' | 'tool_result' }>;

function isPart(event: StreamEvent): event is PartEvent {
  return event.type === 'tool_call_ready' || event.type === 'tool_result';
}

function toPart(event: PartEvent): MessagePart {
  if (event.type === 'tool_call_ready') return { kind: 'tool_call', id: event.id, sql: event.sql };

  return {
    kind: 'tool_result',
    toolCallId: event.toolCallId,
    rowCount: event.rowCount,
    preview: event.preview,
    elapsedMs: event.elapsedMs,
    error: event.error,
  };
}
