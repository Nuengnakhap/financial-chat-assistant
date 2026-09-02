import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import { AsyncQueue } from '../async-queue';
import { delay } from '../timeouts';

/** Collects until the queue ends, so a test reads like the consumer does. */
async function collect(queue: AsyncQueue<number>, signal = new AbortController().signal) {
  const seen: number[] = [];
  for await (const item of queue.drain(signal)) seen.push(item);

  return seen;
}

describe('handing items to a loop that is not there yet', () => {
  it('gives them all in order, whether they arrived before or during the read', async () => {
    const queue = new AsyncQueue<number>(10);
    queue.push(1);
    queue.push(2);

    const reading = collect(queue);
    queue.push(3);
    queue.close();

    expect(await reading).toEqual([1, 2, 3]);
  });

  it('wakes a loop that is already waiting, without a close to prod it', async () => {
    const queue = new AsyncQueue<number>(10);
    const seen: number[] = [];
    const reading = (async () => {
      for await (const item of queue.drain(new AbortController().signal)) {
        seen.push(item);
        return;
      }
    })();
    // Long enough for the loop to reach the wait; if it has not, the push would
    // land in the array instead and prove nothing.
    await delay(1);

    queue.push(7);

    // Nothing closes the queue: without the wake this awaits for ever, which is
    // a hanging test rather than a failing one — and that is the signal.
    await reading;
    expect(seen).toEqual([7]);
  });

  it('ends the loop when the producer closes with nothing left', async () => {
    const queue = new AsyncQueue<number>(10);
    const reading = collect(queue);

    queue.close();

    expect(await reading).toEqual([]);
  });

  it('ignores anything pushed after the close', async () => {
    const queue = new AsyncQueue<number>(10);
    queue.close();
    queue.push(1);

    expect(await collect(queue)).toEqual([]);
  });
});

describe('a consumer that stopped reading', () => {
  it('is cut off at the bound rather than growing the producer memory', async () => {
    const queue = new AsyncQueue<number>(3);
    for (const item of [1, 2, 3, 4]) queue.push(item);

    // What it held is dropped too: keeping three of five would hand the reader
    // a gap it could not see, and a gap read as continuous is worse than a cut.
    expect(await collect(queue)).toEqual([]);
    expect(queue.overflow).toBe(true);
  });

  it('is distinguishable from a stream that simply ended', () => {
    const queue = new AsyncQueue<number>(3);
    queue.push(1);
    queue.close();

    expect(queue.overflow).toBe(false);
  });
});

describe('a reader that goes away', () => {
  it('stops waiting the moment it is cancelled, not when something arrives', async () => {
    const queue = new AsyncQueue<number>(10);
    const controller = new AbortController();
    const reading = collect(queue, controller.signal);

    controller.abort();

    // Nothing is ever pushed and nothing ever closes the queue: if the abort did
    // not wake the wait, this test would hang rather than fail.
    expect(await reading).toEqual([]);
  });

  it('leaves nothing listening on the signal it was given', async () => {
    const queue = new AsyncQueue<number>(10);
    const controller = new AbortController();

    queue.close();
    await collect(queue, controller.signal);

    // A generation adds one of these per connection to a long-lived signal;
    // listeners that outlive their loop are how a process leaks slowly.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
