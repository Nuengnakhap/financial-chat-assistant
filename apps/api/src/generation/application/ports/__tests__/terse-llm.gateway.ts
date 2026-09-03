import { QUERY_TOOL } from '../../prompt.factory';
import {
  FINISH_REASONS,
  type Capabilities,
  type CompletionChunk,
  type CompletionRequest,
  type FinishReason,
  type LlmGateway,
} from '../llm-gateway.port';

/**
 * A second adapter, over a provider that says everything differently.
 *
 * It is not a provider anybody uses. It exists so that the contract suite has
 * to be true of something other than the OpenAI protocol — and the shape was
 * chosen to break every assumption that protocol would smuggle in: this one
 * announces the model and the cost **first** rather than last, hands a tool call
 * over whole in a single event rather than in fragments by position, and spells
 * its finish reasons in its own words.
 *
 * A suite that passes here and against `OpenAiLlmGateway` is testing the port. A
 * sentence that only holds for one of them was never a contract.
 */

export type TerseEvent =
  | {
      readonly t: 'meta';
      readonly model: string;
      readonly prompt: number;
      readonly completion: number;
      readonly cached: number;
    }
  | { readonly t: 'say'; readonly s: string }
  | { readonly t: 'call'; readonly id: string; readonly fn: string; readonly args: string }
  | { readonly t: 'end'; readonly why: string };

interface TerseAsk {
  /** What is being asked for, which a router is free to resolve to anything else. */
  readonly model: string;
  readonly request: CompletionRequest;
}

export interface TerseProvider {
  open(ask: TerseAsk, signal: AbortSignal): Promise<AsyncIterable<TerseEvent>>;
}

/** Its own words for stopping, which have to be mapped rather than passed through. */
const REASONS: Readonly<Record<string, FinishReason>> = {
  end_turn: 'stop',
  wants_tool: 'tool_calls',
  too_long: 'length',
};

export class TerseLlmGateway implements LlmGateway {
  constructor(
    private readonly provider: TerseProvider,
    private readonly model: string,
  ) {}

  async *streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<CompletionChunk> {
    const calls: { id: string; name: string; arguments: string }[] = [];
    let usage: CompletionChunk | null = null;
    let finished = false;

    for await (const event of await this.provider.open(ask(this.model, request), signal)) {
      switch (event.t) {
        case 'meta':
          // Held back: the port hands cost over once, and a caller that has to
          // know whether it has already seen it is a caller doing translation.
          usage = usageOf(event);
          break;
        case 'say':
          yield { kind: 'text', text: event.s };
          break;
        case 'call':
          yield { kind: 'tool_call_delta', index: calls.length, argumentsDelta: event.args };
          calls.push({ id: event.id, name: event.fn, arguments: event.args });
          break;
        case 'end':
          finished = true;
          yield* handOver(calls, REASONS[event.why] ?? 'other');
          break;
      }
    }

    if (!finished) yield* handOver(calls, 'other');
    if (usage !== null) yield usage;
  }

  async checkCapabilities(signal: AbortSignal): Promise<Capabilities> {
    const chunks: CompletionChunk[] = [];
    try {
      for await (const chunk of this.streamCompletion(smokeCall(), signal)) chunks.push(chunk);
    } catch (error) {
      return { usable: false, missing: [describe(error)], model: '' };
    }

    const missing: string[] = [];
    if (chunks.length === 0) missing.push('the endpoint returned no streamed chunks');
    if (!chunks.some((chunk) => chunk.kind === 'tool_calls')) {
      missing.push(`the endpoint did not call ${QUERY_TOOL.name} when asked to`);
    }

    return { usable: missing.length === 0, missing, model: modelIn(chunks) };
  }
}

function* handOver(
  calls: readonly { id: string; name: string; arguments: string }[],
  reason: FinishReason,
): Generator<CompletionChunk> {
  if (calls.length > 0) yield { kind: 'tool_calls', calls: [...calls] };
  yield { kind: 'finish', reason: FINISH_REASONS.includes(reason) ? reason : 'other' };
}

function usageOf(event: Extract<TerseEvent, { t: 'meta' }>): CompletionChunk {
  return {
    kind: 'usage',
    model: event.model,
    usage: {
      promptTokens: event.prompt,
      completionTokens: event.completion,
      cachedPromptTokens: event.cached,
    },
  };
}

function ask(model: string, request: CompletionRequest): TerseAsk {
  return { model, request };
}

function smokeCall(): CompletionRequest {
  return {
    messages: [{ role: 'user', content: `Call ${QUERY_TOOL.name}` }],
    tools: [QUERY_TOOL],
    maxOutputTokens: 64,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'the endpoint could not be reached';
}

function modelIn(chunks: readonly CompletionChunk[]): string {
  return chunks.find((chunk) => chunk.kind === 'usage')?.model ?? '';
}
