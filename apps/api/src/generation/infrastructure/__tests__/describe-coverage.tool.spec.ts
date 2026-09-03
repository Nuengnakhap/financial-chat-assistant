import { verify } from '@fca/grounding';
import { describe, expect, it } from 'vitest';

import { toEvidence } from '../../application/query-outcome';
import { coverageOf, type SemanticCatalog } from '../../application/semantic-catalog';
import type { SemanticCatalogService } from '../../application/semantic-catalog.service';
import { DescribeCoverageTool } from '../describe-coverage.tool';

/**
 * The second tool, and the thing it is for: a refusal that rests on a tool
 * result rather than on what the model was told.
 *
 * The prompt already lists the companies, so this is not about the model
 * knowing the coverage — it is about it being able to *say* the coverage. An
 * answer is checked against tool results and against nothing else, so a
 * sentence naming a figure that only ever appeared in the system prompt is
 * refused exactly like an invented one.
 */

const CATALOG: SemanticCatalog = {
  companies: [
    { company: 'Apple', ticker: 'AAPL', sector: 'Technology', years: [2022, 2023] },
    { company: 'BlackRock', ticker: 'BLK', sector: 'Finance', years: [2023, 2024] },
  ],
  columns: [
    { name: 'company', kind: 'plain', recorded: 4 },
    { name: 'revenue', kind: 'money', recorded: 4 },
    { name: 'gross_profit', kind: 'money', recorded: 3 },
  ],
  rows: 4,
  years: [2022, 2023, 2024],
  fingerprint: 'abc',
};

/**
 * The real projection rather than one built for the test. What this tool answers
 * with and what the verifier knows about have to be the same list of columns,
 * and a hand-written map here would be the second answer that never goes stale
 * in the same direction as the first.
 */
const COVERAGE = coverageOf(CATALOG);

const toolOn = (catalog: SemanticCatalog | null): DescribeCoverageTool =>
  new DescribeCoverageTool({ current: () => catalog } as unknown as SemanticCatalogService);

describe('asking what the dataset covers', () => {
  it('answers in one row, with a figure for every question it is asked', async () => {
    const outcome = await toolOn(CATALOG).execute('call-1');

    expect(outcome.failure).toBeNull();
    expect(outcome.columns).toEqual([
      'rows',
      'companies',
      'first_year',
      'last_year',
      'revenue_recorded',
      'gross_profit_recorded',
    ]);
    expect(outcome.rows).toEqual([['4', '2', '2022', '2024', '4', '3']]);
  });

  it('names the statement its figures answer', async () => {
    // The provenance the first tool has, for the same reason: a number a person
    // is shown should say where it came from, and a tool with no statement
    // behind it would be the one exception in the system.
    const outcome = await toolOn(CATALOG).execute('call-1');

    expect(outcome.sql).toContain('FROM financial_data');
    expect(outcome.sql).toContain('count(DISTINCT company) AS companies');
    expect(outcome.sql).toContain('count(gross_profit) AS gross_profit_recorded');
    // Read on the catalog's schedule rather than a moment ago, and it says so.
    expect(outcome.fromCache).toBe(true);
  });

  it('makes a refusal something that can be checked', async () => {
    const outcome = await toolOn(CATALOG).execute('call-1');

    const said = verify(
      'This dataset does not include Berkshire Hathaway. It covers 2 companies over the fiscal years 2022 to 2024.',
      [toEvidence(outcome)],
      COVERAGE,
    );

    expect(said.verdict).toBe('pass');
  });

  it('and still refuses a coverage figure that is not in it', async () => {
    const outcome = await toolOn(CATALOG).execute('call-1');

    const said = verify('It covers 49 companies.', [toEvidence(outcome)], COVERAGE);

    expect(said.verdict).toBe('fail');
  });

  it('keeps a count of rows apart from the column it counted', async () => {
    // Two things stop this, and both are needed. The column is not called
    // `revenue`, or a count of 4 would be a money cell. And it *is* registered
    // in `Coverage` as plain, because a column the verifier has never heard of
    // is left alone rather than refused — which would put the count back.
    const outcome = await toolOn(CATALOG).execute('call-1');

    const said = verify('Apple earned $4.0.', [toEvidence(outcome)], COVERAGE);

    expect(outcome.columns).not.toContain('revenue');
    expect(said.verdict).toBe('fail');
  });

  it('says nothing rather than a wrong year for a table with no rows in it', async () => {
    // Reachable between a reseed that truncated and one that has not loaded
    // yet. `min(year)` over no rows is null, and printing it as 0 would put a
    // fiscal year nobody has data for in front of a person.
    const empty: SemanticCatalog = { ...CATALOG, companies: [], rows: 0, years: [] };

    const outcome = await toolOn(empty).execute('call-1');

    expect(outcome.rows).toEqual([['0', '0', '', '', '4', '3']]);
  });

  it('says the coverage could not be read rather than throwing', async () => {
    const outcome = await toolOn(null).execute('call-1');

    expect(outcome.rows).toEqual([]);
    expect(outcome.failure?.message).toContain('could not be read');
  });
});
