import { z } from 'zod';

import { uuid } from '../primitives';

/**
 * What the client renders, in the order the events happened. A tool call and its
 * result are separate parts because the SQL is shown while it is still running.
 */

export const toolResultRow = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

export const messagePart = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('tool_call'),
    id: z.string().min(1),
    /** Canonical SQL: the deparsed form that was actually executed, not the model's text. */
    sql: z.string(),
  }),
  z.object({
    kind: z.literal('tool_result'),
    toolCallId: z.string().min(1),
    rowCount: z.number().int().min(0),
    /** Capped server-side; a preview, never the full result set. */
    preview: z.array(toolResultRow).max(20),
    elapsedMs: z.number().int().min(0),
    error: z.string().nullable(),
  }),
]);

export type MessagePart = z.infer<typeof messagePart>;
export type ToolResultRow = z.infer<typeof toolResultRow>;

export const messageRole = z.enum(['user', 'assistant']);
export const messageStatus = z.enum(['generating', 'complete', 'stopped', 'error']);

export type MessageRole = z.infer<typeof messageRole>;
export type MessageStatus = z.infer<typeof messageStatus>;

export const messageIdentity = z.object({
  id: uuid,
  conversationId: uuid,
  seq: z.number().int().min(0),
  role: messageRole,
});
