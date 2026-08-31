import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { TaskRegistry } from '../../bootstrap/task-registry';
import { sleepUnlessCancelled } from '../async/timeouts';
import { AppLogger, asError } from '../observability/app-logger';
import { OutboxRelay } from '../persistence/outbox-relay';

/**
 * Short, because this is the delay between asking for something and it starting
 * to happen. A poll rather than `LISTEN/NOTIFY`: a notification is lost if
 * nobody is listening at that instant, and the whole point of the outbox is
 * that nothing is lost.
 */
const POLL_INTERVAL_MS = 1_000;

/**
 * What turns a committed outbox row into a job. The same shape as the session
 * janitor: the loop registers with `TaskRegistry`, so shutdown waits for a drain
 * in progress and cancels one that is only sleeping.
 */
@Injectable()
export class OutboxPump implements OnApplicationBootstrap {
  constructor(
    private readonly relay: OutboxRelay,
    private readonly tasks: TaskRegistry,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.tasks.spawn('outbox-pump', async (signal) => {
      await this.loop(signal, POLL_INTERVAL_MS);
    });
  }

  /** The interval is a parameter so a test does not have to wait a second to see two rounds. */
  async loop(signal: AbortSignal, intervalMs: number): Promise<void> {
    /* eslint-disable no-await-in-loop -- sequential is the point: two drains at
       once would fight over the same rows, and the wait between them is the
       schedule rather than an accident. */
    while (!signal.aborted) {
      await this.drain();
      if (!(await sleepUnlessCancelled(intervalMs, signal))) return;
    }
    /* eslint-enable no-await-in-loop */
  }

  /**
   * A failure is logged and the loop carries on. The rows are still unpublished,
   * so the next round picks up exactly what this one did not — a pump that
   * stops after one bad second is one nobody notices has stopped.
   */
  private async drain(): Promise<void> {
    try {
      await this.relay.drainAll();
    } catch (error) {
      this.logger.error('outbox drain failed', { task: 'outbox-pump', err: asError(error) });
    }
  }
}
