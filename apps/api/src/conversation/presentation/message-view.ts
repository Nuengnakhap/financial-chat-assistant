import { messagePart, type MessageView } from '@fca/contracts';
import { z } from 'zod';

import type { StoredMessage } from '../application/ports/message.repository';

const parts = z.array(messagePart);

/**
 * The one place a stored message becomes what leaves over HTTP.
 *
 * `parts` is `jsonb`, so its shape is a claim rather than something the row can
 * prove, and it is parsed here for the same reason `verification` is parsed in
 * the repository: a part the client cannot render is better refused loudly than
 * sent as half a message.
 */
export function toMessageView(message: StoredMessage): MessageView {
  return {
    id: message.id,
    conversationId: message.conversationId,
    seq: message.seq,
    role: message.role,
    status: message.status,
    parts: parts.parse(message.parts),
    // The pairing the database holds: an assistant message is `complete`
    // exactly when this is present, so the view's own rule is satisfied by the
    // row rather than by this function remembering to.
    verification: message.verification,
    // Nothing writes either of these yet. `usage` needs a `cached_input_tokens`
    // column the schema does not have, which arrives with the usage ledger; an
    // error is recorded today as `status = 'error'` and nothing more.
    usage: null,
    error: null,
    createdAt: message.createdAt.toISOString(),
  };
}
