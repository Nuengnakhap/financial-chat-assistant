import { ValidationError } from './errors';
import { Err, Ok, type Result } from './result';

/**
 * Every id here is a UUID string, so without a brand `deleteConversation(messageId)`
 * typechecks. The tag exists only in the type system and costs nothing at runtime.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type SessionId = Brand<string, 'SessionId'>;
/** The lineage a session belongs to: rotation makes a new token, not a new family. */
export type SessionFamilyId = Brand<string, 'SessionFamilyId'>;
export type GenerationId = Brand<string, 'GenerationId'>;
export type ReservationId = Brand<string, 'ReservationId'>;
export type ClientMessageId = Brand<string, 'ClientMessageId'>;

/** RFC 9562 layout, versions 1–8. Case-insensitive; canonical form is lowercase. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface IdentifierCodec<T extends string> {
  readonly parse: (raw: string) => Result<T, ValidationError>;
  /** Rows from our own database and ids we generated. Everything else uses `parse`. */
  readonly trusted: (raw: string) => T;
  readonly is: (raw: string) => boolean;
}

function uuidCodec<T extends string>(label: string): IdentifierCodec<T> {
  // The single place allowed to mint a brand, and only after the format check.
  /* eslint-disable @typescript-eslint/consistent-type-assertions */
  const brandIt = (raw: string): T => raw.toLowerCase() as T;
  /* eslint-enable @typescript-eslint/consistent-type-assertions */

  return {
    parse: (raw) =>
      UUID.test(raw)
        ? Ok(brandIt(raw))
        : Err(new ValidationError(`Malformed ${label}.`, { expected: 'uuid', length: raw.length })),
    trusted: brandIt,
    is: (raw) => UUID.test(raw),
  };
}

export const UserId: IdentifierCodec<UserId> = uuidCodec('UserId');
export const ConversationId: IdentifierCodec<ConversationId> = uuidCodec('ConversationId');
export const MessageId: IdentifierCodec<MessageId> = uuidCodec('MessageId');
export const SessionId: IdentifierCodec<SessionId> = uuidCodec('SessionId');
export const SessionFamilyId: IdentifierCodec<SessionFamilyId> = uuidCodec('SessionFamilyId');
export const GenerationId: IdentifierCodec<GenerationId> = uuidCodec('GenerationId');
export const ReservationId: IdentifierCodec<ReservationId> = uuidCodec('ReservationId');
export const ClientMessageId: IdentifierCodec<ClientMessageId> = uuidCodec('ClientMessageId');
