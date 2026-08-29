import { z } from 'zod';

import { isoDateTime, microUsd } from '../primitives';

/**
 * The same numbers the SSE `usage` event carries, so a page that never opened a
 * stream and one that did agree. All amounts are micro-USD strings.
 */
export const usageView = z.object({
  spentMicroUsd: microUsd,
  reservedMicroUsd: microUsd,
  limitMicroUsd: microUsd,
  remainingMicroUsd: microUsd,
  resetAt: isoDateTime,
  exceeded: z.boolean(),
});

export const usageContract = {
  get: { method: 'GET', path: '/api/v1/usage', status: 200, response: usageView },
} as const;

export type UsageView = z.infer<typeof usageView>;
