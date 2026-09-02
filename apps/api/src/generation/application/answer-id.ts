import { Err, MessageId, NotFoundError, Ok, type Result } from '@fca/domain';

const GONE = 'That message does not exist.';

/** A fresh error each time: an `Error` carries a stack, so sharing one lies about where it came from. */
export function answerGone(): NotFoundError {
  return new NotFoundError(GONE);
}

/**
 * A malformed id is not a validation failure to report — it is an id that cannot
 * name anything. Answering 400 for it would separate "wrong shape" from "not
 * yours", which is half of what the 404 exists to hide.
 */
export function requireMessageId(raw: string): Result<MessageId, NotFoundError> {
  const parsed = MessageId.parse(raw);

  return parsed.ok ? Ok(parsed.value) : Err(answerGone());
}
