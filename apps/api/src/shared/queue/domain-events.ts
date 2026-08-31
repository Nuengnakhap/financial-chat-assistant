import { DOMAIN_EVENT_TYPES, type DomainEventType, type JsonValue } from '@fca/domain';
import { z } from 'zod';

import type { PublishedEvent } from '../persistence/outbox-relay';

/** One queue for every domain event; the job name is the type, so a worker can pick. */
export const DOMAIN_EVENTS_QUEUE = 'domain-events';

/** Recursive, so a payload is checked to be JSON rather than assumed to be. */
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/**
 * A job arrives as JSON from Redis, which is outside this process and therefore
 * a boundary — the same rule that makes an HTTP body pass through zod. A queue
 * outlives a deployment: a job written by yesterday's code is still in there
 * after a rename, and parsing is what turns that into a rejected job rather
 * than a `undefined` read three frames deeper.
 */
export const publishedEvent = z.object({
  id: z.string().min(1),
  aggregate: z.string().min(1),
  aggregateId: z.string().min(1),
  type: z.enum(DOMAIN_EVENT_TYPES),
  payload: z.record(z.string(), jsonValue),
});

/**
 * What a context contributes to consume one kind of event. Composed at the
 * composition root rather than collected by each module, for the same reason
 * `HEALTH_INDICATORS` is: NestJS keeps one provider per token, and two modules
 * each contributing their own list would leave one of them silently unused.
 */
export interface DomainEventHandler {
  readonly handles: DomainEventType;
  /**
   * Delivery is at-least-once, so this may be called again with an event it has
   * already finished. Doing the work twice has to be as correct as doing it
   * once — a handler that throws on the second call turns a redelivery into a
   * job that never completes.
   */
  handle(event: PublishedEvent): Promise<void>;
}

export const DOMAIN_EVENT_HANDLERS = Symbol('DomainEventHandlers');
