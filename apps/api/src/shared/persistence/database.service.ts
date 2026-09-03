import type { AppConfig } from '@fca/config';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';
import { APP_CONFIG } from '../config/app-config.token';
import type { HealthIndicator } from '../health/health-indicator';

export type Database = NodePgDatabase<typeof schema>;

const POOL_SIZE = 10;
/** A query still running after this is not slow, it is stuck. */
const STATEMENT_TIMEOUT_MS = 10_000;

/**
 * A `pg` pool emits `error` when a connection sitting idle in it dies — the
 * server restarted, or an administrator terminated it — and `error` with no
 * listener is how an `EventEmitter` ends a Node process. **Measured, not
 * guessed**: stopping Postgres under a running API killed the API, on a path
 * where nothing was being asked and nothing had failed. The pool recovers on
 * its own; there is nothing to do but say so and let it.
 *
 * Logged through `console` rather than `AppLogger` because a pool is built in a
 * constructor that has no logger to inject without giving every caller one — and
 * the alternative to a plain line here is a dead process.
 */
function keepAlive(pool: Pool): void {
  pool.on('error', (error: Error) => {
    // eslint-disable-next-line no-console -- see above
    console.warn(`a pooled connection died while idle: ${error.message}`);
  });
}

@Injectable()
export class DatabaseService implements OnModuleDestroy, HealthIndicator {
  readonly name = 'postgres';
  readonly db: Database;
  private readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    // The runtime role: DML only. Migrations connect as the schema owner
    // through a different URL, so a bug here cannot alter a table.
    this.pool = new Pool({
      connectionString: config.database.url,
      max: POOL_SIZE,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    this.db = drizzle(this.pool, { schema });
    keepAlive(this.pool);
  }

  async check(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
