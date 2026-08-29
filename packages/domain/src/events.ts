/**
 * What one part of the system tells the others has happened. Recorded in the
 * same transaction as the state change that produced it, so a consumer can
 * never be told about something that was then rolled back.
 *
 * Delivery is at-least-once, which makes idempotency the consumer's job:
 * `aggregateId` plus `type` is the key to deduplicate on.
 */

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const DOMAIN_EVENT_TYPES = [
  'conversation.created',
  'conversation.delete_requested',
  'message.appended',
  /** The one that starts real work: a runner picks this up and generates. */
  'generation.requested',
  'generation.closed',
  'usage.recorded',
  'grounding.fallback_used',
  'session.token_reuse_detected',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export interface DomainEvent {
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly type: DomainEventType;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export function isDomainEventType(value: string): value is DomainEventType {
  return DOMAIN_EVENT_TYPES.some((type) => type === value);
}
