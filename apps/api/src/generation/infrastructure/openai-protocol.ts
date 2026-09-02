import { assertNever } from '@fca/domain';
import type OpenAI from 'openai';

import {
  FINISH_REASONS,
  type ChatMessage,
  type CompletionChunk,
  type FinishReason,
  type ToolCall,
  type ToolDefinition,
} from '../application/ports/llm-gateway.port';

/**
 * The translation, and the only place either vocabulary meets the other.
 *
 * Most of it is renaming. The part that is not is the tool calls: they arrive as
 * fragments identified by their position in a list — a name in one chunk, a
 * quarter of the arguments in the next four — and nothing can act on a quarter
 * of a query. They are collected here and handed over once, whole, when the
 * model stops.
 */

type SdkChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type SdkMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type SdkTool = OpenAI.Chat.Completions.ChatCompletionTool;

export function toMessages(messages: readonly ChatMessage[]): SdkMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content };
      case 'user':
        return { role: 'user', content: message.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content,
          // Absent rather than empty: some endpoints reject an empty list where
          // they accept no list at all.
          ...(message.toolCalls.length === 0
            ? {}
            : { tool_calls: message.toolCalls.map(toSdkCall) }),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
      default:
        return assertNever(message, 'toMessages');
    }
  });
}

function toSdkCall(call: ToolCall): OpenAI.Chat.Completions.ChatCompletionMessageToolCall {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  };
}

export function toTools(tools: readonly ToolDefinition[]): SdkTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: asObject(tool.parameters),
    },
  }));
}

/**
 * A JSON Schema is an object, and the port's `JsonValue` admits a string as
 * readily as one. This is the boundary where that has to be settled, and an
 * empty schema is the safe reading of anything else: the model is then told the
 * tool takes nothing rather than told something untrue about it.
 */
function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

export async function* toChunks(stream: AsyncIterable<SdkChunk>): AsyncIterable<CompletionChunk> {
  const calls = new PartialCalls();
  let finished = false;

  for await (const raw of stream) {
    // A usage chunk carries no choices at all, which is why this comes first.
    if (raw.usage) yield usageOf(raw.usage);

    const choice = raw.choices[0];
    if (choice === undefined) continue;

    if (choice.delta.content !== null && choice.delta.content !== undefined) {
      yield { kind: 'text', text: choice.delta.content };
    }
    calls.take(choice.delta.tool_calls);

    if (choice.finish_reason !== null) {
      finished = true;
      yield* calls.flush();
      yield { kind: 'finish', reason: finishReasonOf(choice.finish_reason) };
    }
  }

  // A stream that stopped without saying why still has to end somewhere, or a
  // caller waiting for a reason would wait for a chunk that is never coming.
  if (!finished) {
    yield* calls.flush();
    yield { kind: 'finish', reason: 'other' };
  }
}

interface Partial {
  id: string;
  name: string;
  arguments: string;
}

/** Fragments by position, which is the only thing tying them together. */
class PartialCalls {
  private readonly byIndex = new Map<number, Partial>();

  take(deltas: SdkChunk['choices'][number]['delta']['tool_calls']): void {
    for (const delta of deltas ?? []) {
      const found = this.byIndex.get(delta.index) ?? { id: '', name: '', arguments: '' };
      this.byIndex.set(delta.index, {
        // The id and the name come with the first fragment and the rest carry
        // the arguments. Some endpoints repeat the fields as empty strings
        // rather than leaving them out, and taking those literally would lose
        // the id of the call — which is what the answer to it is addressed to.
        id: keep(delta.id, found.id),
        name: keep(delta.function?.name, found.name),
        arguments: found.arguments + (delta.function?.arguments ?? ''),
      });
    }
  }

  *flush(): Generator<CompletionChunk> {
    if (this.byIndex.size === 0) return;

    const calls = [...this.byIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.arguments }));
    this.byIndex.clear();

    yield { kind: 'tool_calls', calls };
  }
}

function keep(next: string | undefined, existing: string): string {
  return next === undefined || next === '' ? existing : next;
}

function usageOf(usage: OpenAI.Completions.CompletionUsage): CompletionChunk {
  return {
    kind: 'usage',
    usage: {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      // Absent on the first call and on providers that do not cache; zero is the
      // honest reading of both, since nothing was served from a cache either way.
      cachedPromptTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

function finishReasonOf(reason: string): FinishReason {
  const known = FINISH_REASONS.find((candidate) => candidate === reason);
  // `content_filter`, `function_call` and whatever a provider invents next all
  // land on `other`, which is the truthful answer to "why did it stop".
  return known ?? 'other';
}
