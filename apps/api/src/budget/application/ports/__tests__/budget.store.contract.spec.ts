import { MicroUsd } from '@fca/domain';

import { budgetStoreContract } from './budget.store.contract';
import { InMemoryBudgetStore } from './in-memory-budget.store';

/**
 * The contract against the implementation that needs nothing installed. The
 * same suite runs against the Lua scripts on a real Redis in
 * `redis-lua-budget.int.spec.ts`.
 */

const LIMIT = MicroUsd.fromUsd(1);

budgetStoreContract('in memory', () => ({
  store: new InMemoryBudgetStore(LIMIT),
  limit: LIMIT,
}));
