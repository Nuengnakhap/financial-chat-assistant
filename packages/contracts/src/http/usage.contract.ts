import type { z } from 'zod';

import { microUsd } from '../primitives';
import { budgetSnapshot } from '../sse/stream-events.contract';

/**
 * The same numbers the SSE `usage` event carries, so a page that never opened a
 * stream and one that did agree — and one more that is only a subtraction of
 * them, so nothing has to do it twice. All amounts are micro-USD strings.
 */
export const usageView = budgetSnapshot.extend({
  remainingMicroUsd: microUsd,
});

export const usageContract = {
  get: { method: 'GET', path: '/api/v1/usage', status: 200, response: usageView },
} as const;

export type UsageView = z.infer<typeof usageView>;
