/** The public surface. A deep import couples the caller to a file layout free to change. */

export { assertNever } from './assert';
export {
  DOMAIN_EVENT_TYPES,
  isDomainEventType,
  type DomainEvent,
  type DomainEventType,
  type JsonValue,
} from './events';
export {
  BudgetExceededError,
  ConflictError,
  DomainError,
  ForbiddenError,
  InvalidCredentialsError,
  InvalidTransitionError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
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
  SessionFamilyId,
  SessionId,
  UserId,
  type Brand,
  type IdentifierCodec,
} from './identifiers';
export { type OwnerScope } from './ownership';
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

export {
  MESSAGE_STATUSES,
  canTransitionMessage,
  isTerminalMessageStatus,
  transitionMessage,
  type MessageStatus,
} from './conversation/message-status.machine';
export { titleFromMessage } from './conversation/title';
export {
  GENERATION_PHASES,
  INITIAL_GENERATION_PHASE,
  TERMINAL_GENERATION_PHASE,
  canTransitionGeneration,
  nextGenerationPhases,
  transitionGeneration,
  type GenerationOutcome,
  type GenerationPhase,
} from './generation/generation-phase.machine';
export { MicroUsd, type Rounding } from './money/micro-usd.vo';
export { CanonicalSql } from './sql/canonical-sql.vo';
