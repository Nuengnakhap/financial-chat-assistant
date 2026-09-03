import type { Violation } from '@fca/contracts';
import { openGate, type GateEvent } from '@fca/grounding';

import type { AgentEvent } from './agent-events';
import type { GenerationContext } from './generation-context';
import type { AgentTool } from './ports/agent-tool.port';
import type { CompletionRequest, LlmGateway, ToolCall } from './ports/llm-gateway.port';
import type { QueryOutcome } from './ports/tool-outcome';
import { toPreview } from './query-outcome';
import type { Transcript } from './transcript';

/**
 * One draft: the model writing, the database answering, and the gate reading
 * every character before anybody else does.
 *
 * The gate is opened once per round with **everything queried so far**, not with
 * this round's results — an answer written after three queries may refer to any
 * of them. It is opened again each round because the evidence has grown, and a
 * gate cannot be told about a result after it has started reading.
 *
 * A figure with nothing behind it ends the draft on the spot and aborts the
 * stream with it. Waiting for the model to finish would spend tokens on a draft
 * already known to be unusable, and the alternative — correcting it afterwards —
 * is exactly what a reader would already have read.
 */

export type Written =
  | { readonly kind: 'answered'; readonly text: string }
  | { readonly kind: 'violation'; readonly violation: Violation }
  /** Somebody pressed stop. `text` is what the reader was shown before that. */
  | { readonly kind: 'stopped'; readonly text: string }
  /**
   * The endpoint could not be used. What it actually said is logged where it
   * happened; nothing here carries it further, because "connect ECONNREFUSED
   * 10.0.0.1:443" is not a sentence to show anyone waiting for an answer.
   */
  | { readonly kind: 'failed' }
  /** The model kept asking the database and never answered. */
  | { readonly kind: 'exhausted' };

export class Draft {
  constructor(
    private readonly gateway: LlmGateway,
    private readonly tools: readonly AgentTool[],
    private readonly context: GenerationContext,
  ) {}

  async *write(
    transcript: Transcript,
    signal: AbortSignal,
    maxRounds: number,
  ): AsyncGenerator<AgentEvent, Written> {
    for (let round = 0; round < maxRounds; round += 1) {
      const turn = yield* this.streamTurn(transcript, signal);
      if (turn.kind !== 'turn') return turn;

      transcript.appendAssistantTurn(turn.text, turn.calls);
      if (turn.calls.length === 0) return { kind: 'answered', text: turn.text };

      yield* this.answerCalls(turn.calls, transcript);
    }

    return { kind: 'exhausted' };
  }

  /** One exchange with the model, ending in text or in a request for data. */
  private async *streamTurn(
    transcript: Transcript,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, Turn | Written> {
    const gate = openGate(transcript.toolResults(), this.context.coverage);
    // A controller of our own, so a violation can stop the stream without
    // touching the caller's signal — which means something else entirely.
    const local = new AbortController();
    const request = this.ask(transcript);

    let text = '';
    let calls: readonly ToolCall[] = [];

    try {
      for await (const chunk of this.gateway.streamCompletion(
        request,
        AbortSignal.any([signal, local.signal]),
      )) {
        // Asked here rather than left to the client library. Aborting a request
        // whose response has already arrived stops nothing — the chunks are in
        // memory and iteration drains them happily — so a stop pressed late
        // would be answered with a full answer nobody asked for any more.
        if (signal.aborted) {
          local.abort();
          return { kind: 'stopped', text };
        }

        if (chunk.kind === 'tool_calls') calls = chunk.calls;
        if (chunk.kind === 'usage') yield usageOf(chunk.usage, chunk.model);
        if (chunk.kind === 'tool_call_delta') {
          yield { type: 'tool_call_delta', index: chunk.index, argsDelta: chunk.argumentsDelta };
        }
        if (chunk.kind !== 'text') continue;

        const cleared = yield* release(gate.push(chunk.text));
        text += cleared.text;
        if (cleared.violation !== null) {
          // Stop paying for a draft already known to be unusable.
          local.abort();
          return { kind: 'violation', violation: cleared.violation };
        }
      }
    } catch {
      return stoppedOrFailed(signal, text);
    }

    // Only now can what was held back be decided: the last figure in an answer
    // is the one with nothing after it to prove it has ended.
    const last = yield* release(gate.flush());
    text += last.text;
    if (last.violation !== null) return { kind: 'violation', violation: last.violation };

    return { kind: 'turn', text, calls };
  }

  /**
   * Every call gets an answer, including one that was never a query. A call the
   * model makes and never hears back about leaves the next request malformed —
   * the provider requires one `tool` message per call — and the generation would
   * fail on a round that had otherwise worked.
   */
  private async *answerCalls(
    calls: readonly ToolCall[],
    transcript: Transcript,
  ): AsyncGenerator<AgentEvent> {
    for (const call of calls) {
      // One call at a time, in the order they were asked for: a later one may
      // be written to follow from what an earlier one returned.
      // eslint-disable-next-line no-await-in-loop -- see above
      const outcome = await this.run(call);

      yield { type: 'tool_call_ready', id: call.id, sql: outcome.sql ?? call.arguments };
      yield {
        type: 'tool_result',
        toolCallId: call.id,
        rowCount: outcome.rowCount,
        preview: toPreview(outcome),
        elapsedMs: outcome.elapsedMs,
        error: outcome.failure?.message ?? null,
      };
      transcript.appendToolResult(outcome);
    }
  }

  /** Whatever tools this generation was given, and how much it may write. */
  private ask(transcript: Transcript): CompletionRequest {
    return transcript.toRequest(
      this.tools.map((tool) => tool.definition),
      this.context.maxOutputTokens,
    );
  }

  /**
   * Dispatch by the name the model used. A name nothing answers to is an outcome
   * like any other rather than an error: the model picked from a list it was
   * given, and telling it which names are on that list is something it can act
   * on — whereas ending the generation is not.
   */
  private async run(call: ToolCall): Promise<QueryOutcome> {
    const tool = this.tools.find((candidate) => candidate.definition.name === call.name);
    if (tool === undefined) return await Promise.resolve(noSuchTool(call, this.tools));

    return await tool.execute(call.id, call.arguments);
  }
}

function noSuchTool(call: ToolCall, tools: readonly AgentTool[]): QueryOutcome {
  const names = tools.map((tool) => tool.definition.name).join(', ');

  return {
    toolCallId: call.id,
    sql: null,
    columns: [],
    rows: [],
    display: new Map(),
    rowCount: 0,
    truncated: null,
    elapsedMs: 0,
    fromCache: false,
    failure: {
      kind: 'unknown_tool',
      message: `There is no tool called ${call.name}. The tools available are: ${names}.`,
    },
  };
}

interface Cleared {
  readonly text: string;
  readonly violation: Violation | null;
}

/**
 * What the gate let through, sent on as it goes. Text is emitted here rather
 * than collected and emitted later, because the whole point of reading it a
 * piece at a time is that a reader sees it a piece at a time.
 */
function* release(events: readonly GateEvent[]): Generator<AgentEvent, Cleared> {
  let text = '';

  for (const event of events) {
    if (event.kind === 'violation') return { text, violation: event.violation };
    text += event.text;
    yield { type: 'text_delta', delta: event.text };
  }

  return { text, violation: null };
}

interface Turn {
  readonly kind: 'turn';
  readonly text: string;
  readonly calls: readonly ToolCall[];
}

/**
 * Whether the stream ended because somebody asked it to. The distinction is the
 * whole of what happens next: a stop keeps what was written and settles, a
 * failure says so to the person waiting.
 */
function stoppedOrFailed(signal: AbortSignal, text: string): Written {
  if (signal.aborted) return { kind: 'stopped', text };
  return { kind: 'failed' };
}

function usageOf(
  usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cachedPromptTokens: number;
  },
  model: string,
): AgentEvent {
  return {
    type: 'usage',
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cachedInputTokens: usage.cachedPromptTokens,
    model,
  };
}
