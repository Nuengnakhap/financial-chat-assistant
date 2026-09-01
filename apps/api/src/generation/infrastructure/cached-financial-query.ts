import type { CanonicalSql } from '@fca/domain';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LayeredCache } from '../../shared/cache/layered-cache';
import {
  FinancialQueryPool,
  queryDigest,
  type QueryRows,
} from '../../shared/financial/financial-query.pool';
import { AppLogger, asError } from '../../shared/observability/app-logger';
import { K } from '../../shared/redis/keys';

/**
 * Running a validated query, once.
 *
 * Two things belong together here and nowhere else. The table is a static dump,
 * so the same query asked twice has the same answer and the second one need not
 * reach PostgreSQL — and the cache is shared across users on purpose, because
 * there is nothing in this table that belongs to any of them. And this is the
 * one place that sees a query go to the server, which makes it the one place
 * that can say how long it took: the digest and the duration, never the SQL,
 * which says which company somebody asked about.
 */

/** The data changes when someone reseeds it, so an hour is a guess with no downside. */
const CACHE_TTL_SECONDS = 3_600;

/** What a cached reading has to look like to be believed — Redis is a boundary. */
const cachedRows = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string().nullable())),
});

export interface QueryReading extends QueryRows {
  readonly fromCache: boolean;
}

@Injectable()
export class CachedFinancialQuery {
  constructor(
    private readonly pool: FinancialQueryPool,
    private readonly cache: LayeredCache,
    private readonly logger: AppLogger,
  ) {}

  async rows(sql: CanonicalSql): Promise<QueryReading> {
    const started = performance.now();
    const digest = queryDigest(sql);
    let fromCache = true;

    try {
      const rows = await this.cache.get(
        { key: K.queryCache(digest), ttlSeconds: CACHE_TTL_SECONDS, schema: cachedRows },
        async () => {
          fromCache = false;
          return await this.pool.query(sql);
        },
      );

      this.logger.debug('financial query read', {
        scope: 'CachedFinancialQuery',
        sqlDigest: digest,
        rows: rows.rows.length,
        durationMs: Math.round(performance.now() - started),
      });

      return { ...rows, fromCache };
    } catch (error) {
      // The caller turns this into a value for the model to work with, which
      // leaves nobody to notice that queries are timing out or that a grant is
      // missing — readiness cannot see either. So it is said here, where the
      // digest and the duration already are.
      this.logger.warn('financial query failed', {
        scope: 'CachedFinancialQuery',
        sqlDigest: digest,
        durationMs: Math.round(performance.now() - started),
        err: asError(error),
      });
      throw error;
    }
  }
}
