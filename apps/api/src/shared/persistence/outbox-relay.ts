import type { DomainEvent, JsonValue } from '@fca/domain';
import { asc, inArray, isNull } from 'drizzle-orm';

import type { DatabaseService } from './database.service';
import { outboxEvents } from './schema';

/**
 * Where an outbox event goes once it is safely committed. A port because the
 * queue is not this layer's concern — and because a test can then prove the
 * draining logic without a broker.
 */
export interface OutboxPublisher {
  publish(events: readonly PublishedEvent[]): Promise<void>;
}

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

      await withTimeout(this.publisher.publish(rows.map(toPublished)), this.publishTimeoutMs);
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

/** Bounds how long a claim can be held while the broker is unreachable. */
async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`publish timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
