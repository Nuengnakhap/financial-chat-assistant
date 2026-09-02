import type { AppConfig } from '@fca/config';
import type { Coverage } from '@fca/grounding';
import { Inject, Injectable } from '@nestjs/common';

import { renderSystemPrompt } from './prompt.factory';
import { coverageOf } from './semantic-catalog';
import { SemanticCatalogService } from './semantic-catalog.service';
import { APP_CONFIG } from '../../shared/config/app-config.token';

/**
 * Everything a generation needs to know before it starts, in one answer.
 *
 * It is one object rather than three collaborators because the three are one
 * question — what does this dataset hold, and what may the model be told and
 * allowed to say about it — and because they have to agree: the coverage the
 * verifier checks against and the coverage the prompt describes are the same
 * catalog, or an answer can be refused for saying exactly what it was told.
 */

export interface GenerationContext {
  readonly systemPrompt: string;
  readonly coverage: Coverage;
  readonly maxOutputTokens: number;
  /** Which reading of the dataset this is, for a log line or a cache key. */
  readonly fingerprint: string;
}

@Injectable()
export class GenerationContextFactory {
  constructor(
    private readonly catalog: SemanticCatalogService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * `null` while the catalog has never been read — during the first seconds
   * after a start, or for as long as the database is unreachable. A generation
   * cannot begin without it: the model would be told nothing about what this
   * dataset covers and would answer from memory, which is the one thing this
   * system exists to prevent.
   */
  current(): GenerationContext | null {
    const catalog = this.catalog.current();
    if (catalog === null) return null;

    return {
      systemPrompt: renderSystemPrompt(catalog),
      coverage: coverageOf(catalog),
      maxOutputTokens: this.config.llm.maxOutputTokens,
      fingerprint: catalog.fingerprint,
    };
  }
}
