import { ConversationId, Err, NotFoundError, Ok, type Result } from '@fca/domain';

const GONE = 'That conversation does not exist.';

/** A fresh error each time: an `Error` carries a stack, so sharing one lies about where it came from. */
export function conversationGone(reason?: string): NotFoundError {
  return new NotFoundError(GONE, reason === undefined ? {} : { reason });
}

/**
 * A malformed id is not a validation failure to report — it is an id that
 * cannot name anything. Answering 400 for it would separate "wrong shape" from
 * "not yours", which is half of what the 404 exists to hide.
 *
 * Written once because every route that takes an `:id` needs the same answer,
 * and the second copy of a rule like this is where the two stop agreeing.
 */
export function requireConversationId(raw: string): Result<ConversationId, NotFoundError> {
  const parsed = ConversationId.parse(raw);

  return parsed.ok ? Ok(parsed.value) : Err(conversationGone('malformed_id'));
}
