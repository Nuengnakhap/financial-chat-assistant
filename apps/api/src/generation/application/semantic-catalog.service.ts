import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { CATALOG_SOURCE, type CatalogSource } from './ports/semantic-catalog.port';
import type { SemanticCatalog } from './semantic-catalog';
import { TaskRegistry } from '../../bootstrap/task-registry';
import { sleepUnlessCancelled } from '../../shared/async/timeouts';
import { AppLogger, asError } from '../../shared/observability/app-logger';

/**
 * Holds the catalog, and reads it again from time to time.
 *
 * Built once at boot and refreshed on a slow loop, because the alternative —
 * building it per request — would put two queries and a hash in front of every
 * question to answer something that changes when somebody reseeds a database.
 * A failed refresh keeps the previous answer rather than dropping it: an
 * unreachable server for a minute is not a reason to forget what the dataset
 * holds.
 */

/** The data changes when a person runs the seed, so this is about noticing, not tracking. */
const REFRESH_INTERVAL_MS = 600_000;

@Injectable()
export class SemanticCatalogService implements OnApplicationBootstrap {
  private catalog: SemanticCatalog | null = null;

  constructor(
    @Inject(CATALOG_SOURCE) private readonly source: CatalogSource,
    private readonly tasks: TaskRegistry,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.tasks.spawn('catalog-refresh', async (signal) => {
      await this.loop(signal, REFRESH_INTERVAL_MS);
    });
  }

  /** The interval is a parameter so a test need not wait ten minutes to see two reads. */
  async loop(signal: AbortSignal, intervalMs: number): Promise<void> {
    /* eslint-disable no-await-in-loop -- one read at a time, and the wait
       between them is the schedule rather than an accident. */
    while (!signal.aborted) {
      await this.refresh();
      if (!(await sleepUnlessCancelled(intervalMs, signal))) return;
    }
    /* eslint-enable no-await-in-loop */
  }

  async refresh(): Promise<void> {
    try {
      const built = await this.source.build();
      const changed = built.fingerprint !== this.catalog?.fingerprint;
      this.catalog = built;
      if (changed) {
        // Worth a line: it means every prompt prefix from here on is a new one,
        // and the provider's cache of the old one is now so much dead weight.
        this.logger.log('semantic catalog changed', { task: 'catalog-refresh' });
      }
    } catch (error) {
      this.logger.error('catalog refresh failed', { task: 'catalog-refresh', err: asError(error) });
    }
  }

  /**
   * `null` until the first read succeeds. A caller has to decide what to do
   * about that — for a generation, refusing to start is the only honest answer,
   * since without the catalog the model would be told nothing about what this
   * dataset covers and would answer from memory.
   */
  current(): SemanticCatalog | null {
    return this.catalog;
  }
}
