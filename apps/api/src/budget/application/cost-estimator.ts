import { GENERATION_LIMITS, type AppConfig } from '@fca/config';
import type { MicroUsd } from '@fca/domain';
import { MAX_DRAFTS } from '@fca/grounding';
import { Inject, Injectable } from '@nestjs/common';

import { MODEL_IN_USE, type ModelInUse } from './ports/model-in-use.port';
import { PRICING, type Pricing, type TokenCounts } from './pricing';
import { APP_CONFIG } from '../../shared/config/app-config.token';

/**
 * What one generation may cost at its very worst, which is what it holds before
 * it is allowed to start.
 *
 * The loop has a hard ceiling — `MAX_DRAFTS` attempts, each of at most
 * `maxToolRounds` queries plus the round that answers — so the worst case is
 * arithmetic rather than a guess. Every round sends the whole prompt again,
 * which is why the input is counted per round and not once.
 *
 * The prompt is not tokenized here on purpose. Holding happens where a question
 * is accepted, and the prompt is assembled somewhere else entirely; reaching
 * across for a number that a ceiling already bounds would tie the two together
 * for no gain. The tokenizer earns its place at the other end, where a
 * generation that reported no usage still has to be charged for something.
 */
export interface GenerationCeilings {
  readonly maxDrafts: number;
  readonly maxToolRounds: number;
  /** The largest transcript a round can send: prompt, history and tool results. */
  readonly inputCeilingTokens: number;
  readonly maxOutputTokens: number;
}

export function worstCaseTokens(ceilings: GenerationCeilings): TokenCounts {
  const rounds = ceilings.maxDrafts * (ceilings.maxToolRounds + 1);

  return {
    input: ceilings.inputCeilingTokens * rounds,
    // No cache hit at all is the worst case, and it is also what an endpoint
    // that reports nothing looks like.
    cachedInput: 0,
    output: ceilings.maxOutputTokens * rounds,
  };
}

@Injectable()
export class ReservationEstimator {
  private readonly ceilings: GenerationCeilings;
  private readonly configured: string;

  constructor(
    @Inject(PRICING) private readonly pricing: Pricing,
    @Inject(MODEL_IN_USE) private readonly endpoint: ModelInUse,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.configured = config.llm.model;
    this.ceilings = {
      maxDrafts: MAX_DRAFTS,
      maxToolRounds: GENERATION_LIMITS.maxToolRounds,
      inputCeilingTokens: GENERATION_LIMITS.inputCeilingTokens,
      maxOutputTokens: config.llm.maxOutputTokens,
    };
  }

  /**
   * Priced for the model that is answering — which a router only decides per
   * request, so the closest thing available before one is asked is whatever the
   * endpoint answered with last time anybody checked. A name still nobody can
   * price is priced as the dearest there is, which refuses early rather than
   * letting somebody spend past the limit.
   */
  worstCase(): MicroUsd {
    const model = this.endpoint.resolved() ?? this.configured;

    return this.pricing.costOf(model, worstCaseTokens(this.ceilings));
  }

  /** What a generation that has happened costs, which is a different question. */
  costOf(model: string, tokens: TokenCounts): MicroUsd {
    return this.pricing.costOf(model, tokens);
  }
}
