import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { PurgeDeadSessionsUseCase } from './use-cases/purge-dead-sessions.use-case';
import { TaskRegistry } from '../../bootstrap/task-registry';
import { sleepUnlessCancelled } from '../../shared/async/timeouts';
import { AppLogger, asError } from '../../shared/observability/app-logger';

/** Often enough that neither table drifts far, rare enough to be invisible. */
const SWEEP_INTERVAL_MS = 3_600_000;

/**
 * The first recurring job in the app, so it sets the shape: the loop registers
 * with `TaskRegistry`, which means shutdown waits for a sweep in progress and
 * cancels one that is only sleeping.
 */
@Injectable()
export class SessionJanitor implements OnApplicationBootstrap {
  constructor(
    private readonly purge: PurgeDeadSessionsUseCase,
    private readonly tasks: TaskRegistry,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.tasks.spawn('session-janitor', async (signal) => {
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

  private async sweep(): Promise<void> {
    try {
      const removed = await this.purge.execute();
      if (removed > 0) this.logger.debug('removed dead sessions', { task: 'session-janitor' });
    } catch (error) {
      this.logger.error('session sweep failed', { task: 'session-janitor', err: asError(error) });
    }
  }
}
