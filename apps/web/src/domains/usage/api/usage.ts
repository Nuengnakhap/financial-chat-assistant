import { remainingMicroUsd, type BudgetSnapshot, type UsageView } from '@fca/contracts';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';

/**
 * What is left of this window.
 *
 * Read once when a screen opens and written again at the end of every answer —
 * not polled. A budget only moves when something is generated, and this page is
 * the thing generating: it already knows.
 */
const USAGE_KEY = ['usage'];

const usageQuery = queryOptions({
  queryKey: USAGE_KEY,
  queryFn: async ({ signal }): Promise<UsageView> => await api.usage.get({ signal }),
});

export function useUsage(): UsageView | undefined {
  return useQuery(usageQuery).data;
}

/**
 * The figures a generation ended with, put where the meter reads them.
 *
 * Written rather than invalidated: the stream has just said what the window
 * looks like, so asking the server the same question again would be a second
 * request for an answer already in hand.
 */
export function useRecordsWhatWasSpent(): (budget: BudgetSnapshot) => void {
  const queries = useQueryClient();

  return (budget: BudgetSnapshot) => {
    queries.setQueryData(USAGE_KEY, toView(budget));
  };
}

/**
 * A refusal is the other thing that moves the meter, and the 429 that carries
 * it cannot say by how much: the failure shape is closed to a code, a message
 * and a request id, deliberately. So the window is read again — once — and the
 * banner takes `resetAt` from the same figures the meter shows.
 */
export function useReadsUsageAgain(): () => void {
  const queries = useQueryClient();

  return () => {
    void queries.invalidateQueries({ queryKey: USAGE_KEY });
  };
}

/**
 * The stream carries every figure the meter shows except the one that is a
 * subtraction of the others, and that one has a single function to do it —
 * shared with the server, so a meter fed by an event and a meter fed by a page
 * load cannot disagree. Whether another answer will fit is not computed here at
 * all: only the server knows what the next one would hold.
 */
function toView(budget: BudgetSnapshot): UsageView {
  return { ...budget, remainingMicroUsd: remainingMicroUsd(budget) };
}
