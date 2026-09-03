import type { ToolResult } from '@fca/grounding';

import type {
  ChatMessage,
  CompletionRequest,
  ToolCall,
  ToolDefinition,
} from './ports/llm-gateway.port';
import type { QueryOutcome } from './ports/tool-outcome';
import { toEvidence, toModelMessage } from './query-outcome';

/**
 * The conversation as the model will read it, and the evidence as the verifier
 * will read it — two views of the same rounds, kept together because they must
 * not drift apart.
 *
 * Three rules hold it together, and the first two are the provider's rather than
 * ours:
 *
 * 1. **The prefix never moves.** The system message is the same bytes whenever
 *    the catalog is, which is what a provider's automatic prompt caching is
 *    keyed on — 1,536 of 1,825 tokens on the second call, measured.
 * 2. **An assistant turn with tool calls is followed by one `tool` message per
 *    call, in order.** Break it and the endpoint answers 400. It is the easiest
 *    rule in the system to break by accident, because trimming history is
 *    exactly the kind of code that removes half a pair.
 * 3. **A repair instruction is appended, never edited in.** Rewriting an earlier
 *    message would change the prefix and throw away the cache along with it.
 *
 * Evidence is what *this* generation queried and nothing else. An earlier answer
 * in the history may be full of figures, and none of them may be repeated
 * without asking again — `verify` is given the results this transcript holds, so
 * a figure carried over from last time has nothing supporting it. That is a
 * deliberate cost: the alternative is trusting a number because we said it once.
 */

/** A turn from an earlier exchange: what was said, without the working. */
export interface PastTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/**
 * How many earlier turns are replayed. Twenty is the plan's figure and the
 * reasoning is unchanged: enough for a conversation to make sense, short enough
 * that the prefix stays the dominant part of the prompt.
 */
const MAX_HISTORY_TURNS = 20;

export class Transcript {
  /** The system message and the question: the part that never changes again. */
  private readonly opening: readonly ChatMessage[];
  private readonly rounds: ChatMessage[] = [];
  private readonly evidence: ToolResult[] = [];

  constructor(systemPrompt: string, history: readonly PastTurn[], question: string) {
    this.opening = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-MAX_HISTORY_TURNS).map(toChatMessage),
      { role: 'user', content: question },
    ];
  }

  toRequest(tools: readonly ToolDefinition[], maxOutputTokens: number): CompletionRequest {
    return { messages: [...this.opening, ...this.rounds], tools, maxOutputTokens };
  }

  /**
   * What the model said and what it asked for, in one message — the shape the
   * provider expects to see its own tool calls come back in.
   */
  appendAssistantTurn(text: string, toolCalls: readonly ToolCall[]): void {
    this.rounds.push({ role: 'assistant', content: text === '' ? null : text, toolCalls });
  }

  /**
   * The answer to one call. Both readings are recorded here: the JSON the model
   * is shown, and the rows the verifier will check an answer against.
   */
  appendToolResult(outcome: QueryOutcome): void {
    this.rounds.push({
      role: 'tool',
      toolCallId: outcome.toolCallId,
      content: toModelMessage(outcome),
    });
    this.evidence.push(toEvidence(outcome));
  }

  /**
   * Said as a new instruction rather than by rewriting the last one, so the
   * prefix — and the provider's cache of it — survives a repair round.
   */
  appendRepairInstruction(instruction: string): void {
    this.rounds.push({ role: 'system', content: instruction });
  }

  /**
   * Everything this generation has queried, in order. Empty means nothing was
   * asked, which is the difference between a refusal that rests on an empty
   * result and one that rests on the model's reading of the prompt.
   */
  toolResults(): readonly ToolResult[] {
    return [...this.evidence];
  }
}

function toChatMessage(turn: PastTurn): ChatMessage {
  return turn.role === 'user'
    ? { role: 'user', content: turn.text }
    : // Without tool calls, deliberately: replaying an old call would need its
      // result replayed beside it to satisfy the pairing rule, and that result
      // is not evidence for this question.
      { role: 'assistant', content: turn.text, toolCalls: [] };
}
