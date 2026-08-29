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
  }

  async check(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
