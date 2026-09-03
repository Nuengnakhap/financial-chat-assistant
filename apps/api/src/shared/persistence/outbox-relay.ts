import type { DomainEvent, JsonValue } from '@fca/domain';
import { and, asc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';

import type { DatabaseService } from './database.service';
import { outboxEvents } from './schema';
import { withTimeout } from '../async/timeouts';

/**
 * Where an outbox event goes once it is safely committed. A port because the
 * queue is not this layer's concern — and because a test can then prove the
 * draining logic without a broker.
 */
export interface OutboxPublisher {
  publish(events: readonly PublishedEvent[]): Promise<void>;
}

export const OUTBOX_PUBLISHER = Symbol('OutboxPublisher');

export interface PublishedEvent extends DomainEvent {
  /** Stable across redeliveries, so a consumer can deduplicate on it. */
  readonly id: string;
}

const BATCH_SIZE = 100;
/** A broker that has not answered by now is not slow, it is unavailable. */
const PUBLISH_TIMEOUT_MS = 10_000;

/**
 * Delivery is at-least-once by construction: events are published before they
 * are marked, so a crash in between redelivers rather than drops. Losing an
 * event is unrecoverable; seeing one twice is the consumer's job to absorb.
 */
export class OutboxRelay {
  constructor(
    private readonly database: DatabaseService,
    private readonly publisher: OutboxPublisher,
    private readonly publishTimeoutMs = PUBLISH_TIMEOUT_MS,
  ) {}

  /**
   * The publish happens inside the transaction on purpose, and it is the one
   * place this codebase allows external I/O in one. Rolling the claim back is
   * what makes a failed publish redeliver instead of vanish, and holding the row
   * lock is what stops a second relay from picking the same batch up meanwhile.
   * The cost is a lock held across a network call, which the timeout bounds.
   */
  async drainBatch(batchSize = BATCH_SIZE): Promise<number> {
    return await this.database.db.transaction(async (tx) => {
      // SKIP LOCKED is what lets a second relay run without waiting on the
      // first or handing out the same rows twice.
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt))
        .orderBy(asc(outboxEvents.id))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      if (rows.length === 0) return 0;

      await withTimeout(
        this.publisher.publish(rows.map(toPublished)),
        this.publishTimeoutMs,
        'publish',
      );
      await tx
        .update(outboxEvents)
        .set({ publishedAt: new Date() })
        .where(
          inArray(
            outboxEvents.id,
            rows.map((row) => row.id),
          ),
        );

      return rows.length;
    });
  }

  /**
   * Forgets jobs that have been done, and keeps everything else for good.
   *
   * The outbox is two things at once, and this is where that is said out loud.
   * `generation.requested` is a job: one row per question, done the moment a
   * runner picks it up, and the only thing in this table that grows with use.
   * The other two are records — a conversation is hard-deleted, so the request
   * to delete it is the only trace it existed, and a revoked session family says
   * it is gone but not why. Pruning those would be pruning the audit trail.
   *
   * Bounded per sweep rather than one `DELETE` over the lot: a delete that takes
   * a lock on ten million rows blocks the relay behind it, and the relay is on
   * the path between asking a question and it starting to be answered.
   */
  async forgetFinishedJobs(before: Date, batchSize = BATCH_SIZE): Promise<number> {
    const doomed = await this.database.db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, FINISHED_JOB),
          isNotNull(outboxEvents.publishedAt),
          lt(outboxEvents.createdAt, before),
        ),
      )
      .limit(batchSize);

    if (doomed.length === 0) return 0;

    await this.database.db.delete(outboxEvents).where(
      inArray(
        outboxEvents.id,
        doomed.map((row) => row.id),
      ),
    );

    return doomed.length;
  }

  async drainAll(batchSize = BATCH_SIZE): Promise<number> {
    let total = 0;
    let drained = await this.drainBatch(batchSize);
    while (drained > 0) {
      total += drained;
      // Sequential on purpose: each batch has to commit before the next can be
      // claimed, or two rounds would fight over the same rows.
      // eslint-disable-next-line no-await-in-loop
      drained = await this.drainBatch(batchSize);
    }
    return total;
  }
}

/**
 * The one event in the vocabulary that is a job rather than a record. Named here
 * rather than passed in, because "which of these is safe to forget" is a fact
 * about the vocabulary and not a knob.
 */
const FINISHED_JOB = 'generation.requested';

/** The `chk_outbox_type` constraint is what makes the type assertion here true. */
function toPublished(row: typeof outboxEvents.$inferSelect): PublishedEvent {
  /* eslint-disable @typescript-eslint/consistent-type-assertions */
  return {
    id: row.id.toString(),
    aggregate: row.aggregate,
    aggregateId: row.aggregateId,
    type: row.type as PublishedEvent['type'],
    payload: row.payload as Readonly<Record<string, JsonValue>>,
  };
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
}
