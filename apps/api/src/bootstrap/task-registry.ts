import { Injectable } from '@nestjs/common';

import { settledWithin } from '../shared/async/timeouts';
import { AppLogger, asError } from '../shared/observability/app-logger';

/** How long a cancelled task gets to notice its signal before the drain gives up on it. */
const CANCELLATION_GRACE_MS = 2_000;

interface RunningTask {
  readonly name: string;
  readonly promise: Promise<void>;
  readonly abort: AbortController;
}

/**
 * Every background task registers here, so shutdown can wait for work that no
 * request is holding open. A generation that is persisting its result is not
 * visible to the HTTP server, and a plain `void fn()` would be lost on exit.
 */
@Injectable()
export class TaskRegistry {
  private readonly tasks = new Map<number, RunningTask>();
  private nextId = 1;
  private accepting = true;

  constructor(private readonly logger: AppLogger) {}

  /**
   * False once draining has begun. Refusing here rather than at the HTTP edge
   * is what makes the refusal complete: a request already inside the server
   * still cannot start work that shutdown would then have to abandon.
   */
  spawn(name: string, work: (signal: AbortSignal) => Promise<void>): boolean {
    if (!this.accepting) {
      this.logger.warn('refused a background task during shutdown', { task: name });
      return false;
    }

    const id = this.nextId++;
    const abort = new AbortController();
    const promise = Promise.resolve()
      .then(() => work(abort.signal))
      .catch((error: unknown) => {
        this.logger.error('background task failed', { task: name, err: asError(error) });
      })
      .finally(() => {
        this.tasks.delete(id);
      });

    this.tasks.set(id, { name, promise, abort });
    return true;
  }

  get inFlight(): number {
    return this.tasks.size;
  }

  /**
   * Waits, then cancels, then waits again — and returns either way. A shutdown
   * that can be blocked forever by one stuck task is not a shutdown.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.accepting = false;
    if (this.tasks.size === 0) return;

    const settled = this.settlement();
    if (await settledWithin(settled, timeoutMs)) return;

    this.logger.warn('cancelling background tasks that did not finish in time', {
      durationMs: timeoutMs,
    });
    for (const task of this.tasks.values()) task.abort.abort();

    if (!(await settledWithin(settled, CANCELLATION_GRACE_MS))) {
      const names = [...this.tasks.values()].map((task) => task.name).join(', ');
      this.logger.error(`abandoning background tasks that ignored cancellation: ${names}`);
    }
  }

  private settlement(): Promise<unknown> {
    return Promise.allSettled([...this.tasks.values()].map((task) => task.promise));
  }
}
