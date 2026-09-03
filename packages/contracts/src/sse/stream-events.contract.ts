import { z } from 'zod';

import { groundingReport } from '../domain-view/grounding-report';
import { messageView } from '../domain-view/message';
import { toolResultRow } from '../domain-view/message-part';
import { isoDateTime, microUsd, uuid } from '../primitives';

/**
 * Every event the generation stream can emit. Adding one is always safe — a
 * client that does not know it skips it (see `parseStreamEvent`) — but changing
 * what an existing one means is not, because old clients keep the old reading.
 */

export const budgetSnapshot = z.object({
  spentMicroUsd: microUsd,
  reservedMicroUsd: microUsd,
  limitMicroUsd: microUsd,
  resetAt: isoDateTime,
  /**
   * Another answer will not fit. Not the same as "nothing left": a generation
   * holds what it might cost before it starts, so a window with a fraction of a
   * cent in it is spent for every practical purpose — and only the server knows
   * what the next one would hold.
   */
  exceeded: z.boolean(),
});

/**
 * What is left of a window, worked out in one place.
 *
 * The stream carries three figures and the HTTP view carries four, and the
 * fourth is the other three subtracted. Written here rather than on either side
 * so that a meter fed by an event and a meter fed by a page load cannot
 * disagree — and never below zero, because a window that settled past its limit
 * has nothing left rather than a debt.
 *
 * What is held counts as gone: a reservation is money that cannot be spent on
 * anything else, and calling it available offers room the next question would
 * be refused for.
 */
export function remainingMicroUsd(budget: BudgetSnapshot): string {
  const left =
    BigInt(budget.limitMicroUsd) - BigInt(budget.spentMicroUsd) - BigInt(budget.reservedMicroUsd);

  return (left < 0n ? 0n : left).toString();
}

export const streamEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('generation_started'),
    assistantMessageId: uuid,
    model: z.string().min(1),
  }),
  /** Only text that already passed the claim gate reaches the client. */
  z.object({ type: z.literal('text_delta'), delta: z.string() }),
  z.object({
    type: z.literal('tool_call_delta'),
    index: z.number().int().min(0),
    argsDelta: z.string(),
  }),
  z.object({ type: z.literal('tool_call_ready'), id: z.string().min(1), sql: z.string() }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string().min(1),
    rowCount: z.number().int().min(0),
    preview: z.array(toolResultRow).max(20),
    elapsedMs: z.number().int().min(0),
    error: z.string().nullable(),
  }),
  /** A repair round: the client clears the draft and waits for the stream again. */
  z.object({
    type: z.literal('draft_reset'),
    attempt: z.number().int().min(1),
    reason: z.enum(['unverifiable_claim', 'tool_error']),
  }),
  z.object({ type: z.literal('verification'), report: groundingReport }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    costMicroUsd: microUsd,
    budget: budgetSnapshot,
  }),
  /** The server is shutting down; the client reconnects and resumes by id. */
  z.object({ type: z.literal('reconnect_hint') }),
  z.object({ type: z.literal('message_complete'), message: messageView }),
  z.object({ type: z.literal('error'), code: z.string().min(1), message: z.string().min(1) }),
]);

export type StreamEvent = z.infer<typeof streamEvent>;
export type StreamEventType = StreamEvent['type'];
export type BudgetSnapshot = z.infer<typeof budgetSnapshot>;

export const TERMINAL_STREAM_EVENTS: readonly StreamEventType[] = ['message_complete', 'error'];

export function isTerminalStreamEvent(event: StreamEvent): boolean {
  return TERMINAL_STREAM_EVENTS.includes(event.type);
}

/**
 * Returns `null` for anything this client cannot read, so a newer server adding
 * an event never breaks an older tab. The caller reports the miss and moves on.
 */
export function parseStreamEvent(raw: unknown): StreamEvent | null {
  const parsed = streamEvent.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
