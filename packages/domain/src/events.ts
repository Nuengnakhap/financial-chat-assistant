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

/**
 * Three, and every one of them is published by something — checked by a test,
 * because a vocabulary is only true while somebody keeps it true.
 *
 * Five names were removed in M11.3 after two milestones with no publisher:
 * `conversation.created`, `message.appended`, `generation.closed`,
 * `usage.recorded` and `grounding.fallback_used`. Each of them duplicated a row
 * that already exists and outlives it — the conversation, the message, the
 * message's status, the `usage_events` ledger, the message's own outcome — so
 * emitting them would have been a second, weaker answer to a question a table
 * already answers.
 *
 * What survives is what nothing else records. A conversation is hard-deleted,
 * so after the purge the request is the only trace that it existed and was
 * asked for; a reused refresh token revokes a family, and the row it revokes
 * says the family is gone but not why. Those two, plus the one that is a job
 * rather than a record.
 */
export const DOMAIN_EVENT_TYPES = [
  /** Both a job for the purge worker and the only record a conversation was deleted. */
  'conversation.delete_requested',
  /** The one that starts real work: a runner picks this up and generates. */
  'generation.requested',
  /** The only record of *why* a session family was revoked. */
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
