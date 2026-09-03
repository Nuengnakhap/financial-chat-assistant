import type { AppConfig } from '@fca/config';
import { describe, expect, it } from 'vitest';

import { GenerationContextFactory } from '../generation-context';
import type { SemanticCatalog } from '../semantic-catalog';
import type { SemanticCatalogService } from '../semantic-catalog.service';

/**
 * The one question asked before a generation starts, and the one answer that
 * stops it starting at all.
 */

const CATALOG: SemanticCatalog = {
  companies: [{ company: 'Apple', ticker: 'AAPL', sector: 'Technology', years: [2024] }],
  columns: [
    { name: 'company', kind: 'plain', recorded: 1 },
    { name: 'revenue', kind: 'money', recorded: 1 },
  ],
  rows: 1,
  years: [2024],
  fingerprint: 'abc123',
};

const CONFIG = { llm: { maxOutputTokens: 1_500, model: 'a-model' } } as AppConfig;

function factoryFor(catalog: SemanticCatalog | null): GenerationContextFactory {
  const service = { current: () => catalog } as unknown as SemanticCatalogService;
  return new GenerationContextFactory(service, CONFIG);
}

describe('what a generation is told before it starts', () => {
  it('is the prompt and the coverage from one reading of the dataset', () => {
    // The same catalog for both, deliberately: an answer refused for saying
    // exactly what it was told would be the worst kind of wrong.
    const context = factoryFor(CATALOG);

    expect(context.current()).toEqual({
      systemPrompt: expect.stringContaining('- Apple (AAPL, Technology) — 2024'),
      coverage: {
        years: [2024],
        columns: new Map([
          ['company', 'plain'],
          ['revenue', 'money'],
          // The columns `describe_coverage` answers with, registered so that a
          // count in its result cannot support a dollar figure.
          ['rows', 'plain'],
          ['companies', 'plain'],
          ['first_year', 'plain'],
          ['last_year', 'plain'],
          ['revenue_recorded', 'plain'],
        ]),
      },
      maxOutputTokens: 1_500,
      model: CONFIG.llm.model,
      fingerprint: 'abc123',
    });
  });

  it('is nothing at all until the dataset has been read', () => {
    // Not an empty catalog: an empty one would tell the model this dataset
    // covers nothing, and it would answer from memory instead.
    expect(factoryFor(null).current()).toBeNull();
  });
});
