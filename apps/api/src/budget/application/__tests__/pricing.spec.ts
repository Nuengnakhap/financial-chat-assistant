import { MicroUsd } from '@fca/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { worstCaseTokens, type GenerationCeilings } from '../cost-estimator';
import { Pricing, UNPRICED_MODEL, type ModelPricing } from '../pricing';

/**
 * What a generation costs. Everything downstream of this — what may be
 * reserved, what is charged, whether somebody is refused — is this number, so
 * the properties that matter are that it never comes out below the truth and
 * never depends on a number the provider might not send.
 */

const pricing = new Pricing();

const micro = (amount: MicroUsd): bigint => amount.micro;

describe('what a model costs', () => {
  it('prices input and output at the rate the table gives', () => {
    // luna: $0.20 per 1M input, $1.20 per 1M output.
    const cost = pricing.costOf('gpt-5.6-luna', { input: 1_000_000, cachedInput: 0, output: 0 });

    expect(micro(cost)).toBe(200_000n);
    expect(
      micro(pricing.costOf('gpt-5.6-luna', { input: 0, cachedInput: 0, output: 1_000_000 })),
    ).toBe(1_200_000n);
  });

  it('charges the cached part at the cached rate, and the rest at full', () => {
    const cost = pricing.costOf('gpt-5.6-luna', {
      input: 1_000_000,
      cachedInput: 500_000,
      output: 0,
    });

    // Half at $0.20 and half at $0.02 per million.
    expect(micro(cost)).toBe(100_000n + 10_000n);
  });

  it('prices a model nobody has priced at the dearest rate there is', () => {
    // A name that is not in the table is a name whose price is unknown, and
    // guessing low is the only guess that lets somebody spend past the limit.
    const unknown = pricing.costOf('a-model-from-somewhere-else', {
      input: 1_000_000,
      cachedInput: 0,
      output: 1_000_000,
    });

    expect(micro(unknown)).toBe(
      micro(
        pricing.costOf(UNPRICED_MODEL, { input: 1_000_000, cachedInput: 0, output: 1_000_000 }),
      ),
    );
  });

  it('says so rather than charging nothing when a loaded table has no fallback', () => {
    const empty = new Pricing({});

    expect(() => empty.priceOf('gpt-5.6-luna')).toThrow(/no fallback/);
  });
});

describe('a figure that must never come out low', () => {
  it('rounds a fraction of a micro-USD up', () => {
    // One token of luna input is 0.2 micro-USD. Truncating gives zero, which is
    // a request that costs nothing however many times it is made.
    expect(micro(pricing.costOf('gpt-5.6-luna', { input: 1, cachedInput: 0, output: 0 }))).toBe(1n);
  });

  it('never prices below the exact rational cost, for any token counts', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 2_000_000 }),
        fc.nat({ max: 2_000_000 }),
        fc.nat({ max: 2_000_000 }),
        (input, cachedInput, output) => {
          const capped = Math.min(cachedInput, input);
          const price = pricing.priceOf('gpt-5.6-luna');
          const exact =
            BigInt(input - capped) * price.inputPerMTokMicroUsd +
            BigInt(capped) * price.cachedInputPerMTokMicroUsd +
            BigInt(output) * price.outputPerMTokMicroUsd;

          const charged = micro(pricing.costOf('gpt-5.6-luna', { input, cachedInput, output }));

          // Never under, and never more than the one micro rounding can add.
          expect(charged * 1_000_000n).toBeGreaterThanOrEqual(exact);
          expect((charged - 1n) * 1_000_000n).toBeLessThan(exact === 0n ? 1n : exact);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('does not let a cached count above the input make the call cheaper', () => {
    // The number comes from a provider, so it is checked rather than trusted:
    // an uncached half below zero would price the call under what it cost.
    const nonsense = pricing.costOf('gpt-5.6-luna', {
      input: 1_000,
      cachedInput: 9_000_000,
      output: 0,
    });

    expect(micro(nonsense)).toBe(
      micro(pricing.costOf('gpt-5.6-luna', { input: 1_000, cachedInput: 1_000, output: 0 })),
    );
  });

  it('reads a table given to it, so a deployment can price its own models', () => {
    const table: Record<string, ModelPricing> = {
      'llama-on-my-laptop': {
        inputPerMTokMicroUsd: 0n,
        cachedInputPerMTokMicroUsd: 0n,
        outputPerMTokMicroUsd: 0n,
      },
      [UNPRICED_MODEL]: {
        inputPerMTokMicroUsd: 1n,
        cachedInputPerMTokMicroUsd: 1n,
        outputPerMTokMicroUsd: 1n,
      },
    };

    const local = new Pricing(table);

    expect(
      micro(local.costOf('llama-on-my-laptop', { input: 9_000, cachedInput: 0, output: 9_000 })),
    ).toBe(0n);
  });
});

describe('what a generation may reserve', () => {
  const ceilings: GenerationCeilings = {
    maxDrafts: 3,
    maxToolRounds: 5,
    inputCeilingTokens: 8_000,
    maxOutputTokens: 1_500,
  };

  it('counts the whole prompt once per round, because every round sends it again', () => {
    // Three drafts of five queries plus the round that answers: eighteen calls.
    expect(worstCaseTokens(ceilings)).toEqual({
      input: 8_000 * 18,
      cachedInput: 0,
      output: 1_500 * 18,
    });
  });

  it('assumes no cache hit, which is both the worst case and the honest default', () => {
    expect(worstCaseTokens(ceilings).cachedInput).toBe(0);
  });

  it('is a small share of a one-dollar limit at the price of the cheap model', () => {
    const reserved = pricing.costOf('gpt-5.6-luna', worstCaseTokens(ceilings));

    // ~$0.061, so about sixteen answers can be in flight at once against $1.
    expect(reserved.toUsdNumber()).toBeCloseTo(0.061, 3);
    expect(reserved.isLessThan(MicroUsd.fromUsd(0.1))).toBe(true);
  });
});
