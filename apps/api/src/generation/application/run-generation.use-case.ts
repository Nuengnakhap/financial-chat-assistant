import type { GroundingReport, MessagePart, StreamEvent } from '@fca/contracts';
import {
  assertNever,
  type GenerationOutcome,
  type MessageId,
  type MessageStatus,
} from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import type { AgentEvent } from './agent-events';
import { AgentRunner } from './agent-runner';
import { GENERATION_EVENTS, type GenerationEvents } from './ports/generation-events.port';
import {
  GENERATION_MESSAGES,
  type Answer,
  type GenerationMessages,
} from './ports/generation-messages.port';

/**
 * One generation from beginning to end, detached from any connection.
 *
 * Everything the runner produces goes to the stream, and what is left at the end
 * goes to the row. Both endings — an answer and a failure — leave through the
 * same path, so there is no way to finish without the message reaching a
 * terminal state, and no way to reach one without saying so on the stream.
 */

/**
 * What survives the stream. Tool calls are kept as they happen and the text is
 * taken whole from the end, because the text that matters is the draft that was
 * verified — every earlier one was discarded, and a message assembled from
 * deltas would carry the discarded ones too.
 */
class Recording {
  readonly parts: MessagePart[] = [];
  model = '';
  inputTokens = 0;
  outputTokens = 0;
  text = '';
  report: GroundingReport | null = null;
  private outcome: GenerationOutcome | null = null;
  /** True once the runner has put a terminal `error` on the stream. */
  failed = false;

  saw(event: AgentEvent): void {
    if (event.type === 'generation_started') this.model = event.model;
    else if (event.type === 'tool_call_ready') {
      this.parts.push({ kind: 'tool_call', id: event.id, sql: event.sql });
    } else if (event.type === 'tool_result') {
      this.parts.push({ kind: 'tool_result', ...toolResultOf(event) });
    } else if (event.type === 'usage') {
      // Added, not replaced. One of these arrives per round and an ordinary
      // question takes at least two — query, then answer — so keeping the last
      // would drop the round that carried the whole prompt prefix. Every round
      // is billed for the entire prompt it sent, prefix included, which makes
      // the sum the charge rather than a double count.
      this.inputTokens += event.inputTokens;
      this.outputTokens += event.outputTokens;
    } else if (event.type === 'finished') {
      this.outcome = event.outcome;
      this.text = event.text;
      this.report = event.report;
    } else if (event.type === 'error') this.failed = true;
  }

  /**
   * `complete` means verified, and nothing else does. A stop keeps whatever had
   * been written; anything that ends without a report is an error however far it
   * got, because a finished assistant message without one cannot be stored at all.
   */
  get status(): Exclude<MessageStatus, 'generating'> {
    if (this.outcome === 'stopped') return 'stopped';

    return this.report === null ? 'error' : 'complete';
  }

  get stored(): readonly MessagePart[] {
    return this.text === '' ? this.parts : [...this.parts, { kind: 'text', text: this.text }];
  }
}

@Injectable()
export class RunGenerationUseCase {
  constructor(
    private readonly runner: AgentRunner,
    @Inject(GENERATION_MESSAGES) private readonly messages: GenerationMessages,
    @Inject(GENERATION_EVENTS) private readonly events: GenerationEvents,
  ) {}

  async execute(answer: Answer, signal: AbortSignal): Promise<void> {
    const question = await this.messages.questionFor(answer);
    if (question === null) {
      // The row before this one is not a question, so there is nothing to
      // answer. It cannot be left `generating`, which is a state the janitor
      // would keep finding and the conversation would stay blocked by.
      await this.giveUp(answer, 'nothing_to_answer');
      return;
    }

    const recording = new Recording();
    const asked = { question: question.text, history: question.history };
    for await (const event of this.runner.run(asked, signal)) {
      recording.saw(event);
      const streamed = toStreamEvent(answer.id, event);
      if (streamed !== null) await this.events.append(answer.id, streamed);
    }

    await this.settle(answer, recording);
  }

  /**
   * The books, closed. A row that loses this write lost it to a stop or a
   * janitor that had already ended the same generation, and the terminal event
   * it put on the stream is the one clients are reading.
   */
  private async settle(answer: Answer, recording: Recording): Promise<void> {
    const stored = await this.messages.finish({
      messageId: answer.id,
      status: recording.status,
      parts: recording.stored,
      // Present exactly when the status is `complete`, which is what the
      // database's own CHECK constraint insists on. Deriving both from one
      // reading of the recording is what keeps them agreeing.
      verification: recording.status === 'complete' ? recording.report : null,
      model: recording.model,
      inputTokens: recording.inputTokens,
      outputTokens: recording.outputTokens,
    });

    if (stored === null || recording.failed) return;
    await this.events.append(answer.id, { type: 'message_complete', message: stored });
  }

  /**
   * Ends a generation that never had anything to run, without asking the model.
   *
   * The row first and the stream second, as everywhere else: the conditional
   * write is what decides which of several writers ended a generation, and
   * saying so on the stream before asking would let a loser put a second
   * terminal event behind somebody else's.
   */
  private async giveUp(answer: Answer, code: string): Promise<void> {
    const stored = await this.messages.finish({
      messageId: answer.id,
      status: 'error',
      parts: [],
      verification: null,
      model: '',
      inputTokens: 0,
      outputTokens: 0,
    });
    if (stored === null) return;

    await this.events.append(answer.id, {
      type: 'error',
      code,
      message: 'Something went wrong while writing the answer. Please try asking again.',
    });
  }
}

/**
 * The one place the runner's vocabulary becomes the client's. Most of it is the
 * same shape by design — the contract was written first and the runner's events
 * were named after it — and the two that are not are the two that never leave
 * this process: what a generation cost, and how it ended.
 */
function toStreamEvent(messageId: MessageId, event: AgentEvent): StreamEvent | null {
  // Recorded, not streamed. Usage reaches a client as part of the finished
  // message once there is a price to put on it; `finished` is this process
  // telling itself the loop is over, and what a client reads instead is the
  // message that was stored because of it.
  if (event.type === 'usage' || event.type === 'finished') return null;

  return toClientEvent(messageId, event);
}

function toClientEvent(messageId: MessageId, event: ClientEvent): StreamEvent {
  switch (event.type) {
    case 'generation_started':
      return { type: 'generation_started', assistantMessageId: messageId, model: event.model };
    case 'tool_result':
      return { type: 'tool_result', ...toolResultOf(event) };
    case 'text_delta':
    case 'tool_call_delta':
    case 'tool_call_ready':
    case 'draft_reset':
    case 'verification':
    case 'error':
      return event;
    default:
      return assertNever(event, 'agent event');
  }
}

type ClientEvent = Exclude<AgentEvent, { type: 'usage' | 'finished' }>;

/** Copied rather than passed on: the contract's array is mutable and this one is not. */
function toolResultOf(event: Extract<AgentEvent, { type: 'tool_result' }>) {
  return {
    toolCallId: event.toolCallId,
    rowCount: event.rowCount,
    preview: [...event.preview],
    elapsedMs: event.elapsedMs,
    error: event.error,
  };
}
