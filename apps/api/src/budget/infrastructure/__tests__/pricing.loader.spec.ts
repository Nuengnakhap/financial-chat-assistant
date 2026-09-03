import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig } from '@fca/config';
import { describe, expect, it } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import { UNPRICED_MODEL } from '../../application/pricing';
import { loadPricing } from '../pricing.loader';

/**
 * Prices from a file. A price is not a secret and not a schema — it is a number
 * that changes on somebody else's schedule — so it can come from outside the
 * build. What must not come from outside is a table with a hole in it, because
 * a hole is a model that costs nothing.
 */

const folder = mkdtempSync(join(tmpdir(), 'fca-pricing-'));

function configWith(contents: string | null): AppConfig {
  const base = testConfig();
  if (contents === null) return { ...base, usage: { ...base.usage, pricingPath: null } };

  const path = join(folder, `${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, contents);

  return { ...base, usage: { ...base.usage, pricingPath: path } };
}

const complete = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    [UNPRICED_MODEL]: {
      inputPerMTokMicroUsd: '4000000',
      cachedInputPerMTokMicroUsd: '400000',
      outputPerMTokMicroUsd: '20000000',
    },
    ...over,
  });

describe('where prices come from', () => {
  it('uses the table shipped here when nothing else is given', () => {
    const pricing = loadPricing(configWith(null));

    expect(pricing.priceOf('gpt-5.6-luna').inputPerMTokMicroUsd).toBe(200_000n);
  });

  it('reads a deployment’s own prices when it has some', () => {
    const pricing = loadPricing(
      configWith(
        complete({
          'llama-on-my-laptop': {
            inputPerMTokMicroUsd: '0',
            cachedInputPerMTokMicroUsd: '0',
            outputPerMTokMicroUsd: '0',
          },
        }),
      ),
    );

    expect(pricing.priceOf('llama-on-my-laptop').outputPerMTokMicroUsd).toBe(0n);
  });
});

describe('a price table that cannot be trusted', () => {
  it('stops the process rather than pricing a model at nothing', () => {
    // A budget enforced against a table with a hole in it is not a budget, and
    // the hole would be invisible until somebody spent through it.
    expect(() => loadPricing(configWith('{"gpt-5.6-luna":{"inputPerMTokMicroUsd":"1"}}'))).toThrow(
      /not a price table/,
    );
  });

  it('insists on a price for the models nobody has priced', () => {
    expect(() =>
      loadPricing(
        configWith(
          JSON.stringify({
            'gpt-5.6-luna': {
              inputPerMTokMicroUsd: '1',
              cachedInputPerMTokMicroUsd: '1',
              outputPerMTokMicroUsd: '1',
            },
          }),
        ),
      ),
    ).toThrow(new RegExp(UNPRICED_MODEL));
  });

  it('refuses a rate that is not a whole number of micro-USD', () => {
    // `0.2` is a price in dollars, and reading it as micro-USD would be five
    // million times wrong in the direction that lets somebody spend.
    expect(() =>
      loadPricing(
        configWith(
          complete({
            'gpt-5.6-luna': {
              inputPerMTokMicroUsd: '0.2',
              cachedInputPerMTokMicroUsd: '0.02',
              outputPerMTokMicroUsd: '1.2',
            },
          }),
        ),
      ),
    ).toThrow(/not a price table/);
  });

  it('says which file it could not read', () => {
    const base = testConfig();
    const missing = {
      ...base,
      usage: { ...base.usage, pricingPath: join(folder, 'nothing.json') },
    };

    expect(() => loadPricing(missing)).toThrow(/could not be read/);
  });
});
