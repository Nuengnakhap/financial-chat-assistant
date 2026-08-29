import { z } from 'zod';

import { isoDateTime, microUsd, uuid } from '../primitives';
import { groundingReport } from './grounding-report';
import { messagePart, messageRole, messageStatus } from './message-part';

export const usageFacts = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  costMicroUsd: microUsd,
});

const messageShape = z.object({
  id: uuid,
  conversationId: uuid,
  seq: z.number().int().min(0),
  role: messageRole,
  status: messageStatus,
  parts: z.array(messagePart),
  verification: groundingReport.nullable(),
  usage: usageFacts.nullable(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).nullable(),
  createdAt: isoDateTime,
});

/**
 * An assistant message is `complete` exactly when it carries a verification
 * report — the no-hallucination guarantee expressed on the wire, matching the
 * `CHECK` constraint the database will hold. Enforced here rather than described,
 * so a payload that claims a finished answer without evidence cannot be built.
 */
export const messageView = messageShape.refine(
  (message) =>
    (message.role === 'assistant' && message.status === 'complete') ===
    (message.verification !== null),
  { error: 'a verification report is present exactly when an assistant message is complete' },
);

export const conversationView = z.object({
  id: uuid,
  title: z.string().min(1).max(120),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export type UsageFacts = z.infer<typeof usageFacts>;
export type MessageView = z.infer<typeof messageShape>;
export type ConversationView = z.infer<typeof conversationView>;
