import { verify, type Coverage } from '@fca/grounding';
import { describe, expect, it } from 'vitest';

import { QUERY_TOOL, QUERY_TOOL_NAME, renderSystemPrompt } from '../prompt.factory';
import { coverageOf, type SemanticCatalog } from '../semantic-catalog';

/**
 * The prompt is the one part of this system that cannot be made correct by
 * construction, so what is testable about it is testable here: that it says what
 * the dataset actually holds, that it says the things measurement showed the
 * model needs told, and that it is byte-identical for an unchanged catalog —
 * which is what a provider's prompt cache is keyed on.
 *
 * Whether the model then does as it is asked is a different kind of question,
 * answered by running it against the real endpoint.
 */

const CATALOG: SemanticCatalog = {
  companies: [
    { company: 'Apple', ticker: 'AAPL', sector: 'Technology', years: [2022, 2023, 2024, 2025] },
    { company: 'BlackRock', ticker: 'BLK', sector: 'Finance', years: [2022, 2023] },
    { company: "McDonald's", ticker: 'MCD', sector: 'Consumer', years: [2024] },
  ],
  columns: [
    { name: 'company', kind: 'plain', recorded: 9 },
    { name: 'year', kind: 'plain', recorded: 9 },
    { name: 'revenue', kind: 'money', recorded: 7 },
    { name: 'gross_profit', kind: 'money', recorded: 2 },
  ],
  rows: 9,
  years: [2022, 2023, 2024, 2025],
  fingerprint: 'abc123',
};

describe('the system prompt', () => {
  it('is byte-identical for the same catalog', () => {
    // What prompt caching is keyed on. Measured against the configured endpoint:
    // 1,536 of 1,825 prompt tokens came back cached on a second call.
    expect(renderSystemPrompt(CATALOG)).toBe(renderSystemPrompt(CATALOG));
  });

  it('changes when the dataset does', () => {
    const withoutBlackRock = {
      ...CATALOG,
      companies: CATALOG.companies.filter((company) => company.ticker !== 'BLK'),
    };

    expect(renderSystemPrompt(withoutBlackRock)).not.toBe(renderSystemPrompt(CATALOG));
  });

  it('spells the companies the way the table spells them', () => {
    // `WHERE company = 'McDonald's'` is what the model has to write, apostrophe
    // and all, so the name it is shown has to be the stored one rather than a
    // tidied version of it.
    expect(renderSystemPrompt(CATALOG)).toContain("- McDonald's (MCD, Consumer) — 2024");
  });

  it('gives each company its own years rather than a range for all of them', () => {
    // Two companies in the real dataset do not have all four years, so a header
    // saying "2022-2025" would be false for them.
    const prompt = renderSystemPrompt(CATALOG);

    expect(prompt).toContain('- Apple (AAPL, Technology) — 2022, 2023, 2024, 2025');
    expect(prompt).toContain('- BlackRock (BLK, Finance) — 2022, 2023');
    expect(prompt).not.toContain('2022-2025');
  });

  it('summarises the gaps per column instead of naming companies', () => {
    // Naming them costs little and says something untrue: a company missing one
    // year would be listed as missing the column altogether.
    const prompt = renderSystemPrompt(CATALOG);

    expect(prompt).toContain('- revenue: recorded in 7 of 9 rows');
    expect(prompt).toContain('- gross_profit: recorded in 2 of 9 rows');
    expect(prompt).not.toContain('company: recorded');
  });

  it('says the six things that were measured to matter', () => {
    const prompt = renderSystemPrompt(CATALOG);

    // Copy the display strings — without them the model wrote SQL to format
    // figures and failed to finish two questions in twelve.
    expect(prompt).toContain('Copy figures from the "display" values');
    // Its answer is checked, which is what makes that rule make sense.
    expect(prompt).toContain('checked automatically while it streams');
    // Order with NULLS LAST, or "the five largest" starts with the ones that
    // have no figure at all.
    expect(prompt).toContain('NULLS LAST');
    // Query before refusing, because a refusal with no query behind it is
    // rejected by verification exactly like an unsupported figure.
    expect(prompt).toContain('Before saying this dataset does not have something, query for it');
    // A ratio in the result and a percentage in the sentence are different
    // numbers, and the sentence is the one that gets checked.
    expect(prompt).toContain('multiply by 100 there, so the result holds 6.4 rather than 0.064');
    // Dividing two amounts throws the fraction away, and the model only finds
    // out by reading a column of zeroes and querying again.
    expect(prompt).toContain('dividing one by another throws the fraction away');
  });

  it('asks for wording the verifier recognises as a refusal', () => {
    // The phrase the prompt asks for and the phrase the verifier looks for have
    // to be the same phrase. If they drift, either a correct refusal is thrown
    // away as groundless, or — worse — one made without querying is let through.
    const coverage: Coverage = coverageOf(CATALOG);
    const asked = /"(this dataset does not have [^"]*)"/u.exec(renderSystemPrompt(CATALOG))?.[1];
    const refusal = `Sorry, ${String(asked)} for Ferrari.`;

    // With nothing queried it is refused, which is what proves the phrase is
    // recognised at all.
    expect(verify(refusal, [], coverage).verdict).toBe('fail');
    expect(verify(refusal, [], coverage).violations[0]?.reason).toBe('no_evidence');
    // With a query behind it — even one that came back empty — it is accepted.
    expect(
      verify(refusal, [{ toolCallId: 'call-1', columns: [], rows: [] }], coverage).verdict,
    ).toBe('pass');
  });

  it('names the tool the same way everywhere', () => {
    // The prompt tells the model to call it by name; the definition is what the
    // provider matches that name against.
    expect(QUERY_TOOL.name).toBe(QUERY_TOOL_NAME);
    expect(renderSystemPrompt(CATALOG)).toContain(`${QUERY_TOOL_NAME}(sql)`);
  });

  it('describes a tool that takes one SELECT and nothing else', () => {
    expect(QUERY_TOOL.parameters).toEqual({
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT statement over financial_data.' },
      },
      required: ['sql'],
      additionalProperties: false,
    });
  });
});

describe('the coverage the verifier is given', () => {
  it("is the catalog's years and column kinds, and not its companies", () => {
    expect(coverageOf(CATALOG)).toEqual({
      years: [2022, 2023, 2024, 2025],
      columns: new Map([
        ['company', 'plain'],
        ['year', 'plain'],
        ['revenue', 'money'],
        ['gross_profit', 'money'],
      ]),
    });
  });
});
