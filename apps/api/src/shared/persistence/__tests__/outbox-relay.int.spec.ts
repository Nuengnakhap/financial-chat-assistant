import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OutboxRelay, type OutboxPublisher, type PublishedEvent } from '../outbox-relay';
import { outboxEvents } from '../schema';
import { startHarness, type Harness } from './harness';
import type { DatabaseService } from '../database.service';

let h: Harness;

class RecordingPublisher implements OutboxPublisher {
  readonly published: PublishedEvent[] = [];
  failNext = false;

  publish(events: readonly PublishedEvent[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('broker unavailable'));
    }
    this.published.push(...events);
    return Promise.resolve();
  }
}

/** Blocks inside publish until released, so two relays can be caught overlapping. */
class BlockingPublisher implements OutboxPublisher {
  readonly seen: string[][] = [];
  private release: (() => void) | undefined;

  publish(events: readonly PublishedEvent[]): Promise<void> {
    this.seen.push(events.map((event) => event.id));
    return new Promise((resolve) => {
      this.release = resolve;
    });
  }

  finish(): void {
    this.release?.();
  }
}

const relayFor = (publisher: OutboxPublisher) =>
  new OutboxRelay({ db: h.db } as unknown as DatabaseService, publisher);

async function seed(count: number): Promise<void> {
  await h.db.insert(outboxEvents).values(
    Array.from({ length: count }, (_unused, index) => ({
      aggregate: 'conversation',
      aggregateId: crypto.randomUUID(),
      type: 'conversation.created',
      payload: { index },
    })),
  );
}

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

describe('draining', () => {
  it('publishes what is waiting and marks it', async () => {
    await seed(3);
    const publisher = new RecordingPublisher();

    expect(await relayFor(publisher).drainBatch()).toBe(3);

    expect(publisher.published).toHaveLength(3);
    const rows = await h.db.select().from(outboxEvents);
    expect(rows.every((row) => row.publishedAt !== null)).toBe(true);
  });

  it('does nothing when there is nothing to do', async () => {
    expect(await relayFor(new RecordingPublisher()).drainBatch()).toBe(0);
  });

  it('never publishes the same event twice across runs', async () => {
    await seed(2);
    const publisher = new RecordingPublisher();
    const relay = relayFor(publisher);

    await relay.drainBatch();
    await relay.drainBatch();

    expect(publisher.published).toHaveLength(2);
  });

  it('keeps the order events were written in', async () => {
    await seed(5);
    const publisher = new RecordingPublisher();

    await relayFor(publisher).drainBatch();

    expect(publisher.published.map((event) => Number(event.id))).toEqual([1, 2, 3, 4, 5]);
  });

  it('walks through more events than one batch holds', async () => {
    await seed(7);
    const publisher = new RecordingPublisher();

    // drainAll keeps claiming batches until the table is empty.
    expect(await relayFor(publisher).drainAll(3)).toBe(7);

    expect(publisher.published).toHaveLength(7);
  });

  it('stops immediately when there is nothing waiting', async () => {
    expect(await relayFor(new RecordingPublisher()).drainAll()).toBe(0);
  });
});

describe('at-least-once delivery', () => {
  it('leaves an event unmarked when the broker refuses it', async () => {
    await seed(1);
    const publisher = new RecordingPublisher();
    publisher.failNext = true;

    await expect(relayFor(publisher).drainBatch()).rejects.toThrow('broker unavailable');

    // Publishing before marking is the whole design: losing an event is
    // unrecoverable, seeing it twice is the consumer's job to absorb.
    expect((await h.db.select().from(outboxEvents))[0]?.publishedAt).toBeNull();
  });

  it('redelivers it on the next run', async () => {
    await seed(1);
    const publisher = new RecordingPublisher();
    publisher.failNext = true;
    const relay = relayFor(publisher);

    await expect(relay.drainBatch()).rejects.toThrow();
    expect(await relay.drainBatch()).toBe(1);

    expect(publisher.published).toHaveLength(1);
  });

  it('gives every event a stable id a consumer can deduplicate on', async () => {
    await seed(2);
    const publisher = new RecordingPublisher();

    await relayFor(publisher).drainBatch();

    const ids = publisher.published.map((event) => event.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);
  });
});

describe('a broker that never answers', () => {
  it('gives the claim back rather than holding the lock forever', async () => {
    await seed(1);
    const blocking = new BlockingPublisher();
    const relay = new OutboxRelay({ db: h.db } as unknown as DatabaseService, blocking, 200);

    await expect(relay.drainBatch()).rejects.toThrow(/timed out/);
    blocking.finish();

    // The transaction rolled back, so the event is still there for the next run.
    expect((await h.db.select().from(outboxEvents))[0]?.publishedAt).toBeNull();
  });
});

describe('two relays running at once', () => {
  it('do not hand the same event to both', async () => {
    await seed(4);
    const blocking = new BlockingPublisher();
    const recording = new RecordingPublisher();

    // The first relay holds its rows under FOR UPDATE while the second runs.
    const first = relayFor(blocking).drainBatch();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const secondCount = await relayFor(recording).drainBatch();
    blocking.finish();
    await first;

    // SKIP LOCKED is what makes the second relay return empty instead of
    // blocking on the first or duplicating its work.
    expect(secondCount).toBe(0);
    expect(recording.published).toEqual([]);
    expect(blocking.seen[0]).toHaveLength(4);
  });
});
