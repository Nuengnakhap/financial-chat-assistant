import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { ForgetFinishedJobs } from './forget-finished-jobs';
import { TaskRegistry } from '../../bootstrap/task-registry';
import { sleepUnlessCancelled } from '../async/timeouts';
import { AppLogger, asError } from '../observability/app-logger';

/**
 * Forgets outbox rows that were only ever jobs, and keeps the ones that are the
 * only record of something.
 *
 * The relay marks a row published and never deletes it, which makes
 * `outbox_events` append-only by accident rather than by decision — good for
 * the two events that are the only trace of a deleted conversation and of a
 * revoked session family, and unbounded growth for the one written per
 * question. This is the decision, made in one place: which of them is a job.
 *
 * Slow on purpose. Nothing depends on this having run, and a sweep that fights
 * the relay for locks on the path between a question and its answer would be
 * paying for tidiness with latency.
 */
const SWEEP_INTERVAL_MS = 3_600_000;

@Injectable()
export class OutboxJanitor implements OnApplicationBootstrap {
  constructor(
    private readonly forget: ForgetFinishedJobs,
    private readonly tasks: TaskRegistry,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.tasks.spawn('outbox-janitor', async (signal) => {
      await this.loop(signal, SWEEP_INTERVAL_MS);
    });
  }

  /** The interval is a parameter so a test does not have to wait an hour to see two sweeps. */
  async loop(signal: AbortSignal, intervalMs: number): Promise<void> {
    /* eslint-disable no-await-in-loop -- sequential is the point: two sweeps at
       once would fight over the same rows, and the wait between them is the
       schedule rather than an accident. */
    while (!signal.aborted) {
      await this.sweep();
      if (!(await sleepUnlessCancelled(intervalMs, signal))) return;
    }
    /* eslint-enable no-await-in-loop */
  }

  /**
   * A failure is logged and the loop carries on. Nothing is waiting on this, and
   * a janitor that stops after one bad hour is one nobody notices has stopped.
   */
  private async sweep(): Promise<void> {
    try {
      const forgotten = await this.forget.execute();
      if (forgotten > 0) this.logger.debug('forgot finished jobs', { task: 'outbox-janitor' });
    } catch (error) {
      this.logger.error('outbox sweep failed', { task: 'outbox-janitor', err: asError(error) });
    }
  }
}
