import type { JsonValue } from '@fca/domain';

/**
 * The model, as everything above this line is allowed to know it.
 *
 * No type from a provider SDK appears here or anywhere outside
 * `generation/infrastructure`. That is not tidiness: the protocol has details —
 * tool call arguments arriving as fragments indexed by position, usage turning
 * up in a chunk of its own after the last token — that a runner would otherwise
 * have to understand, and that a second provider would spell differently. What
 * comes out of here is text, finished tool calls, what it cost, and why it
 * stopped.
 */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** A JSON Schema object. Structure, not the SDK's idea of structure. */
  readonly parameters: JsonValue;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON as the model wrote it, parsed by whoever knows what the tool takes. */
  readonly arguments: string;
}

export type ChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls: readonly ToolCall[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly maxOutputTokens: number;
}

interface CompletionUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Prompt tokens the provider served from its own cache, when it says so. */
  readonly cachedPromptTokens: number;
}

export const FINISH_REASONS = ['stop', 'tool_calls', 'length', 'other'] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

/**
 * A tool call arrives twice over: as fragments while the model writes it, and
 * once more whole when it stops. Only the second is worth acting on — nothing
 * can run a quarter of a query — but the first is worth showing, because a
 * person watching a query being written is watching the assistant work rather
 * than watching a spinner.
 */
export type CompletionChunk =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool_call_delta';
      /** Which call, when a model asks for two at once. */
      readonly index: number;
      readonly argumentsDelta: string;
    }
  | { readonly kind: 'tool_calls'; readonly calls: readonly ToolCall[] }
  | { readonly kind: 'usage'; readonly usage: CompletionUsage }
  | { readonly kind: 'finish'; readonly reason: FinishReason };

/** What a smoke call at boot found out, in the words a person needs to fix it. */
export interface Capabilities {
  readonly usable: boolean;
  /** Empty when usable; otherwise what is missing, said plainly. */
  readonly missing: readonly string[];
}

export interface LlmGateway {
  streamCompletion(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionChunk>;
  /**
   * One small call with one tool. Answers "can this endpoint do the two things
   * the system is built on" — stream, and call a tool — rather than "is it up".
   */
  checkCapabilities(signal: AbortSignal): Promise<Capabilities>;
}

export const LLM_GATEWAY = Symbol('LlmGateway');
