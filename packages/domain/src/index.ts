/** The public surface. A deep import couples the caller to a file layout free to change. */

export { assertNever } from './assert';
export {
  BudgetExceededError,
  ConflictError,
  DomainError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  UnverifiableClaimError,
  ValidationError,
  isDomainError,
  type DomainErrorCode,
  type DomainErrorDetails,
} from './errors';
export {
  ClientMessageId,
  ConversationId,
  GenerationId,
  MessageId,
  ReservationId,
  UserId,
  type Brand,
  type IdentifierCodec,
} from './identifiers';
export {
  Err,
  Ok,
  allOk,
  andThen,
  expectOk,
  isErr,
  isOk,
  mapErr,
  mapOk,
  unwrapOr,
  type Result,
} from './result';

export { MicroUsd, type Rounding } from './money/micro-usd.vo';
