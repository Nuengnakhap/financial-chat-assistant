import type { GroundingReport, ToolResultRow } from '@fca/contracts';
import type { GenerationOutcome } from '@fca/domain';

/**
 * What one generation emits as it happens.
 *
 * Deliberately not the SSE contract, though the names are the same wherever they
 * can be: this is the runner talking to whoever is driving it, and what reaches a
 * browser is `streamEvent` in `@fca/contracts`, mapped by the layer that writes
 * the stream. The two differ in the places that matter — this one has no budget
 * snapshot, because the runner does not know what anything costs, and no message
 * view, because the message is not saved until the runner has finished.
 *
 * Every `text_delta` here has already been through the claim gate. Nothing else
 * in this list carries a figure a person will read as an answer.
 */
export type AgentEvent =
  /** First of every generation that gets as far as asking the model anything. */
  | { readonly type: 'generation_started'; readonly model: string }
  | { readonly type: 'text_delta'; readonly delta: string }
  /** The model writing a query, a fragment at a time, before it can be run. */
  | { readonly type: 'tool_call_delta'; readonly index: number; readonly argsDelta: string }
  /** The query as it will actually run: canonical, not as the model typed it. */
  | { readonly type: 'tool_call_ready'; readonly id: string; readonly sql: string }
  | {
      readonly type: 'tool_result';
      readonly toolCallId: string;
      readonly rowCount: number;
      readonly preview: readonly ToolResultRow[];
      readonly elapsedMs: number;
      readonly error: string | null;
    }
  /**
   * The draft so far is being thrown away; a reader clears it and waits again.
   *
   * The reason is always the same one, and the contract's wider set is not
   * mirrored here: a tool that fails is a value the model reads and works
   * around, not a reason to throw away what it has written. A second reason will
   * belong here when something emits it.
   */
  | {
      readonly type: 'draft_reset';
      readonly attempt: number;
      readonly reason: 'unverifiable_claim';
    }
  | { readonly type: 'verification'; readonly report: GroundingReport }
  | {
      readonly type: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
      /** Of the input, how many the provider served from its own cache. */
      readonly cachedInputTokens: number;
    }
  /**
   * The last event of every generation that reached an end of its own. `report`
   * is present exactly when there is an answer to have checked — a stopped
   * generation has a partial text and nothing to verify.
   */
  | {
      readonly type: 'finished';
      readonly outcome: GenerationOutcome;
      readonly text: string;
      readonly report: GroundingReport | null;
    }
  /** Written for a person: no exception name, no stack, no provider detail. */
  | { readonly type: 'error'; readonly code: string; readonly message: string };
