/**
 * A hand-off between one producer and one consumer, where the consumer is a
 * `for await` loop and the producer is not.
 *
 * Bounded on purpose. The producer here is a Redis reader shared by every
 * connection on this process, so a consumer that stops reading — a phone that
 * went into a tunnel with the socket still open — must not be able to grow a
 * buffer in the reader's memory. Past the bound the queue drops what it holds
 * and closes, and `overflowed` says so: the caller can tell "the stream ended"
 * from "you fell too far behind", and only the second one needs a reconnect.
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private notify: (() => void) | null = null;
  private closed = false;
  private overflowed = false;

  constructor(private readonly capacity: number) {}

  /** Dropped once the queue is closed: a late arrival is not an error. */
  push(item: T): void {
    if (this.closed) return;
    if (this.items.length >= this.capacity) {
      this.overflowed = true;
      this.items.length = 0;
      this.close();
      return;
    }

    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  /** True when the consumer was cut off rather than reaching the end. */
  get overflow(): boolean {
    return this.overflowed;
  }

  /**
   * One consumer only — a second `for await` over the same queue would take
   * items from the first rather than see the same ones.
   */
  async *drain(signal: AbortSignal): AsyncGenerator<T> {
    const wake = (): void => {
      this.wake();
    };
    signal.addEventListener('abort', wake, { once: true });

    try {
      /* eslint-disable no-await-in-loop -- the wait is the loop: it ends the
         moment something is pushed, and there is nothing to run beside it. */
      while (!signal.aborted) {
        const next = this.items.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (this.closed) return;

        await new Promise<void>((resolve) => {
          this.notify = resolve;
        });
      }
      /* eslint-enable no-await-in-loop */
    } finally {
      signal.removeEventListener('abort', wake);
    }
  }

  private wake(): void {
    const waiting = this.notify;
    this.notify = null;
    waiting?.();
  }
}
