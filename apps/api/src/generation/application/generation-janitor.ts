import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { EndAbandonedGenerationsUseCase } from './use-cases/end-abandoned-generations.use-case';
import { TaskRegistry } from '../../bootstrap/task-registry';
import { sleepUnlessCancelled } from '../../shared/async/timeouts';
import { AppLogger, asError } from '../../shared/observability/app-logger';

/**
 * Often enough that a conversation blocked by a dead runner is usable again
 * within about the time it takes to wonder why it is not, and rare enough to
 * cost nothing when — as is almost always the case — there is nothing to do.
 */
const SWEEP_INTERVAL_MS = 60_000;

/** The same shape as `SessionJanitor`, deliberately: shutdown waits for a sweep
 * in progress and cancels one that is only sleeping. */
@Injectable()
export class GenerationJanitor implements OnApplicationBootstrap {
  constructor(
    private readonly endAbandoned: EndAbandonedGenerationsUseCase,
    private readonly tasks: TaskRegistry,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.tasks.spawn('generation-janitor', async (signal) => {
      await this.loop(signal, SWEEP_INTERVAL_MS);
    });
  }

  /** The interval is a parameter so a test does not have to wait a minute to see two sweeps. */
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
      for (const messageId of await this.endAbandoned.execute(new Date())) {
        // Warn rather than debug: every line here is somebody who watched an
        // answer stop halfway, and a run of them is a process dying repeatedly.
        this.logger.warn('ended a generation nothing was writing any more', {
          task: 'generation-janitor',
          messageId,
        });
      }
    } catch (error) {
      // A failed sweep is one more minute of a stuck row, not a reason to stop
      // sweeping for the lifetime of the process.
      this.logger.error('generation sweep failed', {
        task: 'generation-janitor',
        err: asError(error),
      });
    }
  }
}
