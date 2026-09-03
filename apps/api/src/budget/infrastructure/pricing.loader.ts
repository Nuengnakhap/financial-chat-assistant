import { readFileSync } from 'node:fs';

import type { AppConfig } from '@fca/config';
import { z } from 'zod';

import { Pricing, UNPRICED_MODEL, type ModelPricing } from '../application/pricing';

/**
 * Prices from a file, when a deployment has its own.
 *
 * A price is not a secret and not a schema: it is a number that changes on
 * somebody else's schedule, and needing a release to follow it is how a budget
 * comes to be enforced at yesterday's rates. `PRICING_PATH` is read once at
 * boot, and anything wrong with it stops the process — an endpoint that priced
 * everything at nothing would be a spending limit that never spends.
 */
const rate = z.string().regex(/^\d+$/, 'must be a whole number of micro-USD per million tokens');

const table = z.record(
  z.string().min(1),
  z.object({
    inputPerMTokMicroUsd: rate,
    cachedInputPerMTokMicroUsd: rate,
    outputPerMTokMicroUsd: rate,
  }),
);

export function loadPricing(config: AppConfig): Pricing {
  if (config.usage.pricingPath === null) return new Pricing();

  const parsed = table.safeParse(read(config.usage.pricingPath));
  if (!parsed.success) {
    throw new Error(
      `PRICING_PATH holds something that is not a price table: ${parsed.error.message}`,
    );
  }

  const loaded = Object.fromEntries(
    Object.entries(parsed.data).map(([model, prices]) => [model, toPricing(prices)]),
  );
  // Without one, an unknown model has nothing to be priced at, and the whole
  // point of the fallback is that there is no free path.
  if (loaded[UNPRICED_MODEL] === undefined) {
    throw new Error(
      `PRICING_PATH must price "${UNPRICED_MODEL}", which is what an unknown model costs`,
    );
  }

  return new Pricing(loaded);
}

function read(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`PRICING_PATH could not be read: ${path}`, { cause: error });
  }
}

function toPricing(prices: z.infer<typeof table>[string]): ModelPricing {
  return {
    inputPerMTokMicroUsd: BigInt(prices.inputPerMTokMicroUsd),
    cachedInputPerMTokMicroUsd: BigInt(prices.cachedInputPerMTokMicroUsd),
    outputPerMTokMicroUsd: BigInt(prices.outputPerMTokMicroUsd),
  };
}
