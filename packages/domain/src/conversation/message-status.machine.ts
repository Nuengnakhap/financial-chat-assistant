import { InvalidTransitionError } from '../errors';
import { Err, Ok, type Result } from '../result';

/**
 * A message starts as `generating` and reaches exactly one terminal state. The race
 * this exists for is Stop arriving while the runner persists a finished answer:
 * first writer wins, which is why every write is conditional on `status = 'generating'`.
 *
 * The list is the source of truth, the union derives from it, and `ALLOWED` is keyed
 * by that union — so a new status without a transition rule is a compile error.
 */
export const MESSAGE_STATUSES = ['generating', 'complete', 'stopped', 'error'] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

const ALLOWED: Readonly<Record<MessageStatus, readonly MessageStatus[]>> = {
  generating: ['complete', 'stopped', 'error'],
  complete: [],
  stopped: [],
  error: [],
};

export function isTerminalMessageStatus(status: MessageStatus): boolean {
  return ALLOWED[status].length === 0;
}

export function canTransitionMessage(from: MessageStatus, to: MessageStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function transitionMessage(
  from: MessageStatus,
  to: MessageStatus,
): Result<MessageStatus, InvalidTransitionError> {
  if (!canTransitionMessage(from, to)) {
    return Err(
      new InvalidTransitionError(`Message cannot move from ${from} to ${to}.`, { from, to }),
    );
  }
  return Ok(to);
}
