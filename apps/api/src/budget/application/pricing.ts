import { MicroUsd } from '@fca/domain';

/**
 * What a model costs, and therefore what a generation may reserve before it
 * starts and what it is charged when it ends.
 *
 * Prices are micro-USD per million tokens, held as `bigint` for the same reason
 * every other amount is: the budget path has no float in it anywhere.
 */

export interface ModelPricing {
  readonly inputPerMTokMicroUsd: bigint;
  /**
   * A prefix the provider served from its own cache. Present in the table
   * because the prompt is built to be cacheable; never load-bearing, because
   * whether an endpoint reports one at all is a fact about that endpoint.
   */
  readonly cachedInputPerMTokMicroUsd: bigint;
  readonly outputPerMTokMicroUsd: bigint;
}

/**
 * Keyed by the name the **provider answers with**, which is not always the name
 * it was asked for: a router accepts `auto` and resolves it per request.
 *
 * The figures are the ones written down beside `OPENAI_MODEL` in `.env.example`.
 * A deployment on other prices sets `PRICING_PATH` rather than editing this.
 */
const REGISTRY: Readonly<Record<string, ModelPricing>> = {
  'gpt-5.6-luna': {
    inputPerMTokMicroUsd: 200_000n,
    cachedInputPerMTokMicroUsd: 20_000n,
    outputPerMTokMicroUsd: 1_200_000n,
  },
  'gpt-5.6-terra': {
    inputPerMTokMicroUsd: 2_000_000n,
    cachedInputPerMTokMicroUsd: 200_000n,
    outputPerMTokMicroUsd: 12_000_000n,
  },
  'gpt-5.6-sol': {
    inputPerMTokMicroUsd: 4_000_000n,
    cachedInputPerMTokMicroUsd: 400_000n,
    outputPerMTokMicroUsd: 20_000_000n,
  },
};

/**
 * What an unknown model costs: the dearest thing in the table.
 *
 * Guessing high refuses somebody early; guessing low lets them spend past the
 * limit, and the limit is the whole point. A name nobody has priced is
 * therefore expensive on purpose — and expensive enough to be noticed rather
 * than to become a default nobody looks at.
 */
export const UNPRICED_MODEL = 'gpt-5.6-sol';

export interface TokenCounts {
  readonly input: number;
  /** Of the input, how many the provider served from a cache. Zero prices at full rate. */
  readonly cachedInput: number;
  readonly output: number;
}

const PER_MILLION = 1_000_000n;

export class Pricing {
  constructor(private readonly table: Readonly<Record<string, ModelPricing>> = REGISTRY) {}

  priceOf(model: string): ModelPricing {
    const known = this.table[model] ?? this.table[UNPRICED_MODEL];
    // A table loaded from a file could be missing the fallback as easily as the
    // model, and a budget with no price is not a budget.
    if (known === undefined) {
      throw new Error(`pricing has no entry for "${model}" and no fallback to fall back on`);
    }

    return known;
  }

  /**
   * Rounds up. `bigint` division truncates, which is rounding down, and one
   * micro-USD given away per round is how a budget stops being one.
   *
   * `cachedInput` above `input` would make the uncached half negative and price
   * the call below what it cost, so it is clamped rather than trusted: it comes
   * from a provider, and a boundary is where that is checked.
   */
  costOf(model: string, tokens: TokenCounts): MicroUsd {
    const price = this.priceOf(model);
    const cached = BigInt(Math.max(0, Math.min(tokens.cachedInput, tokens.input)));
    const uncached = BigInt(Math.max(0, tokens.input)) - cached;
    const perMillion =
      uncached * price.inputPerMTokMicroUsd +
      cached * price.cachedInputPerMTokMicroUsd +
      BigInt(Math.max(0, tokens.output)) * price.outputPerMTokMicroUsd;

    return MicroUsd.fromMicro(perMillion).dividedBy(PER_MILLION, 'up');
  }
}

export const PRICING = Symbol('Pricing');
