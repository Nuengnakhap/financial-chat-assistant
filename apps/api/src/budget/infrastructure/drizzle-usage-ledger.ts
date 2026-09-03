import { MicroUsd, type UserId } from '@fca/domain';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '../../shared/persistence/database.service';
import { usageEvents } from '../../shared/persistence/schema';
import type { UsageLedger } from '../application/ports/usage-ledger.port';

/**
 * One window, added up. `idx_usage_user_window` is the index this query is for,
 * and it is asked at most once per person per window — the first time anything
 * touches a counter that Redis does not have.
 */
@Injectable()
export class DrizzleUsageLedger implements UsageLedger {
  constructor(private readonly database: DatabaseService) {}

  async spentIn(userId: UserId, windowStart: Date): Promise<MicroUsd> {
    const [row] = await this.database.db
      .select({
        // `coalesce` in SQL rather than a null check here: an empty window is a
        // sum of nothing, which is zero, and saying so once is better than
        // saying it in two languages.
        total: sql<string>`coalesce(sum(${usageEvents.costMicroUsd}), 0)::text`,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, userId), eq(usageEvents.windowStart, windowStart)));

    // As text, because `sum()` over `bigint` is `numeric` and a driver that
    // handed it back as a JavaScript number would round exactly the amounts
    // this column exists to keep exact.
    return row === undefined ? MicroUsd.ZERO : MicroUsd.fromMicroString(row.total);
  }
}
