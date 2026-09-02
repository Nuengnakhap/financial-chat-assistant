import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXAMPLES } from '../examples';

/**
 * The one place in the browser that says something about the data.
 *
 * Everything else on screen comes from a query result, so the copy is the only
 * thing that can drift away from the dataset without anything noticing — an
 * invitation that ends in "this dataset does not include it" is the worst first
 * answer this application can give. Read from the seed the database is loaded
 * from, because that is where the coverage is decided.
 */

// Assembled rather than written as `new URL(..., import.meta.url)`: Vite reads
// that spelling as an asset reference and rewrites it to a URL its dev server
// would serve, which is not a path anything can read from disk.
const SEED = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../data/financial_data.sql',
);

interface Coverage {
  readonly companies: ReadonlySet<string>;
  readonly years: ReadonlySet<string>;
}

/** The rows of the `COPY` block, which are the only tab-separated lines in the dump. */
function covered(): Coverage {
  const companies = new Set<string>();
  const years = new Set<string>();

  for (const line of readFileSync(SEED, 'utf8').split('\n')) {
    const [company, , , year] = line.split('\t');
    if (company === undefined || year === undefined || !/^\d{4}$/.test(year)) continue;

    companies.add(company);
    years.add(year);
  }

  return { companies, years };
}

const COVERAGE = covered();

/**
 * Whether a question names this company, at word boundaries: `Visa` inside
 * `revision` is not a mention, and a name is written the way the data spells it
 * or it is not the same company. The name goes in as text rather than as a
 * pattern, because `AT&T` and `McDonald's` are ordinary here.
 */
function mentions(question: string, company: string): boolean {
  const literal = company.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

  return new RegExp(String.raw`\b${literal}\b`, 'u').test(question);
}

describe('the questions the empty screen offers', () => {
  it('reads a dataset to check them against', () => {
    // If this ever fails the rest of the file is meaningless: an empty set
    // covers nothing, so every other assertion here would be about the parsing
    // rather than about the copy.
    expect(COVERAGE.companies.size).toBeGreaterThan(1);
    expect(COVERAGE.years.size).toBeGreaterThan(1);
  });

  it.each(EXAMPLES)('names only companies the data holds: $question', ({ about }) => {
    for (const company of about) expect(COVERAGE.companies).toContain(company);
  });

  it.each(EXAMPLES)('asks only about years the data holds: $question', ({ question }) => {
    for (const year of question.match(/\b\d{4}\b/g) ?? []) {
      expect(COVERAGE.years).toContain(year);
    }
  });

  it.each(EXAMPLES)('says out loud what it is about: $question', ({ question, about }) => {
    // Otherwise the annotation is a second copy of the truth, free to be right
    // about a company the sentence no longer mentions.
    for (const company of about) expect(question).toContain(company);
  });

  it.each(EXAMPLES)('annotates every company it names: $question', ({ question, about }) => {
    // The other direction, which is the one copy drifts in: a name added to a
    // question and not to `about` is checked against nothing, and the first
    // company somebody adds is the one this dataset turns out not to have.
    for (const company of COVERAGE.companies) {
      if (mentions(question, company)) expect(about).toContain(company);
    }
  });
});
