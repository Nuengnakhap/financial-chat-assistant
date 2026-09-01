import type { Violation } from '@fca/contracts';
import {
  formatUsd,
  readNumeric,
  roundToInteger,
  valueOf,
  type ColumnKind,
  type Coverage,
  type ToolResult,
} from '@fca/grounding';

import * as recorded from './results';

/**
 * The golden set: a recorded query result, an answer, and what should happen to
 * it.
 *
 * Two halves, and they measure different things. The written cases carry real
 * phrasing — several are verbatim from the configured model — and pin the exact
 * reason a figure is refused, because a verdict that is right for the wrong
 * reason gives a repair round nothing to act on. The generated cases pair every
 * recorded result with a grounded answer and a fabricated one in four different
 * shapes, and pin only the verdict; what they buy is breadth over real values —
 * negatives, nulls, decimals, boundaries — in every place an answer can put a
 * number.
 */

interface Expectation {
  readonly verdict: 'pass' | 'fail';
  /** The reasons expected, in order. Only the written cases assert these. */
  readonly reasons?: readonly Violation['reason'][];
  /** Set when the correct behaviour is to say this dataset cannot answer. */
  readonly unavailable?: true;
  /**
   * Set when the streaming gate legitimately lets this answer through and only
   * the finished-answer check refuses it.
   *
   * The gate decides one figure at a time, so it can enforce everything that is
   * a property of a figure — evidence, coverage, units. Whether a chart plots
   * something the prose never mentions is a property of the whole answer, and
   * the chart may arrive before the paragraph that would have mentioned it. So
   * this is the verifier's to catch, and the cost of that is a repair round
   * rather than a false figure: every number the gate released was supported.
   */
  readonly gateReleases?: true;
}

export interface GoldenCase {
  readonly name: string;
  readonly results: readonly ToolResult[];
  readonly answer: string;
  readonly expect: Expectation;
}

/** What the catalog would say about this dataset, built once and shared. */
export const COVERAGE: Coverage = {
  years: [2022, 2023, 2024, 2025],
  columns: new Map<string, ColumnKind>([
    ['revenue', 'money'],
    ['net_income', 'money'],
    ['operating_income', 'money'],
    ['gross_profit', 'money'],
    ['average_revenue', 'money'],
    ['value', 'money'],
    ['year', 'plain'],
  ]),
};

/**
 * Figures no result in this suite can support. The largest recorded value is
 * 643B and the widest sum here is under 3T, so a figure in trillions is beyond
 * anything the evidence could hold — and if one of these ever does find support,
 * the suite says so rather than passing quietly.
 */
const IMPOSSIBLE = ['$8.8T', '$9.3T', '-$7.7T', '$8,800,000,000,000', '770.4%'];

const impossible = (index: number): string => IMPOSSIBLE[index % IMPOSSIBLE.length] ?? '$8.8T';

/** The string a tool result would have handed the model for this cell. */
function display(text: string, column: string): string {
  if (COVERAGE.columns.get(column) !== 'money') return text;

  const reading = readNumeric(text);
  return reading === null ? text : formatUsd(roundToInteger(valueOf(reading)));
}

function moneyColumn(result: ToolResult): string {
  return result.columns.find((column) => COVERAGE.columns.get(column) === 'money') ?? '';
}

interface Figure {
  /** As a tool result would have handed it to the model. */
  readonly shown: string;
  /** As the column holds it, which is what a chart datum carries. */
  readonly raw: string;
}

/** The first recorded figure in the result, as the answer would write it. */
function firstFigure(result: ToolResult): Figure | null {
  const column = moneyColumn(result);
  const index = result.columns.indexOf(column);
  const row = result.rows.find(
    (candidate) => candidate[index] !== null && candidate[index] !== undefined,
  );
  const raw = row?.[index];

  return raw === null || raw === undefined ? null : { shown: display(raw, column), raw };
}

/**
 * Every place an answer can put a number. The union is derived from the list
 * rather than written beside it, so adding a shape here is a compile error in
 * `WRITE` below until it has been given one — one edit, enforced from one place,
 * the way the domain's closed sets are declared.
 */
const SHAPES = ['prose', 'table', 'chart', 'full'] as const;

type Shape = (typeof SHAPES)[number];

const WRITE: Readonly<Record<Shape, (figure: Figure, column: string) => string>> = {
  prose: (figure) => `The dataset records **${figure.shown}** for that.`,
  table: (figure, column) =>
    ['| Metric | Value |', '|---|---:|', `| ${column} | ${figure.shown} |`].join('\n'),
  chart: (figure, column) =>
    ['```chart', `{"type":"bar","data":[{"${column}":${figure.raw}}]}`, '```'].join('\n'),
  full: (figure) => `The recorded figure is ${figure.raw}.`,
};

/**
 * One grounded case and one fabricated case per shape, per recorded result.
 *
 * The fabricated half replaces the figure with one the evidence cannot hold
 * rather than nudging the real one, so the verdict is unambiguous without the
 * case having to reason about which derived values happen to exist.
 */
function generated(): readonly GoldenCase[] {
  const cases: GoldenCase[] = [];

  recorded.RECORDED.forEach((result, resultIndex) => {
    const figure = firstFigure(result);
    if (figure === null) return;

    const column = moneyColumn(result);
    SHAPES.forEach((shape, shapeIndex) => {
      const at = resultIndex * SHAPES.length + shapeIndex;
      cases.push({
        name: `${result.toolCallId} · ${shape} · grounded`,
        results: [result],
        answer: WRITE[shape](figure, column),
        expect: { verdict: 'pass' },
      });
      cases.push({
        name: `${result.toolCallId} · ${shape} · fabricated`,
        results: [result],
        answer: WRITE[shape]({ shown: impossible(at), raw: '8800000000000' }, column),
        expect: { verdict: 'fail' },
      });
    });
  });

  return cases;
}

/**
 * Written by hand, and several taken word for word from the configured model.
 * These are the cases where the reason matters as much as the verdict.
 */
const WRITTEN: readonly GoldenCase[] = [
  {
    name: 'a figure copied from the results',
    results: [recorded.appleNetIncome],
    answer: "Apple's net income in 2023 was **$97.0B**.",
    expect: { verdict: 'pass' },
  },
  {
    name: 'the litmus test: recorded revenue, not the figure the world knows',
    results: [recorded.johnsonRevenue],
    answer: "Johnson & Johnson's recorded revenue for 2023 is **$21.4B**.",
    expect: { verdict: 'pass' },
  },
  {
    name: 'the litmus test failed: the figure from outside the dataset',
    results: [recorded.johnsonRevenue],
    answer: "Johnson & Johnson's revenue in 2023 was about **$85.2B**.",
    expect: { verdict: 'fail', reasons: ['no_evidence'] },
  },
  {
    name: 'a growth rate the model worked out in its head',
    results: [recorded.nvidiaRevenue],
    answer:
      "Nvidia's revenue grew from **$26.9B in 2022** to **$130.5B in 2025**, an increase of **300.0%**.",
    expect: { verdict: 'fail', reasons: ['no_evidence'] },
  },
  {
    name: 'the growth rate those rows do imply',
    results: [recorded.nvidiaRevenue],
    answer: 'Revenue grew **384.9%** between 2022 and 2025.',
    expect: { verdict: 'pass' },
  },
  {
    name: 'one display string away from the truth',
    results: [recorded.appleNetIncome],
    answer: 'It was $96.9B.',
    expect: { verdict: 'fail', reasons: ['value_mismatch'] },
  },
  {
    name: 'money supported only by a year',
    results: [recorded.appleNetIncome],
    answer: 'The figure was $2,023.',
    expect: { verdict: 'fail', reasons: ['unit_mismatch'] },
  },
  {
    name: 'a year the dataset does not cover',
    results: [recorded.appleNetIncome],
    answer: 'In 2019, net income was $97.0B.',
    expect: { verdict: 'fail', reasons: ['out_of_coverage'] },
  },
  {
    name: 'both edges of a rounding boundary',
    results: [recorded.teslaGrossProfit],
    answer: 'Gross profit was $17.4B, or $17.5B rounded the other way.',
    expect: { verdict: 'pass' },
  },
  {
    name: 'a loss written in millions beside one written in billions',
    results: [recorded.intelNetIncome],
    answer: [
      '| Year | Net income |',
      '|---|---:|',
      '| 2022 | $8.0B |',
      '| 2023 | $1.7B |',
      '| 2024 | -$18.8B |',
      '| 2025 | -$267.0M |',
    ].join('\n'),
    expect: { verdict: 'pass' },
  },
  {
    name: 'the smallest magnitude in the table, negative',
    results: [recorded.abbvieNetIncome],
    answer: "AbbVie's net income in 2024 was **-$22.0M**.",
    expect: { verdict: 'pass' },
  },
  {
    name: 'a sign flipped on a loss',
    results: [recorded.intelNetIncome],
    answer: 'Intel made **$18.8B** in 2024.',
    expect: { verdict: 'fail', reasons: ['no_evidence'] },
  },
  {
    name: 'an average with eight decimals, written as a display string',
    results: [recorded.sectorAverages],
    answer: 'Consumer averaged **$157.3B** in revenue.',
    expect: { verdict: 'pass' },
  },
  {
    name: 'the same average copied out in full',
    results: [recorded.sectorAverages],
    answer: 'Consumer averaged 157282577777.77777778.',
    expect: { verdict: 'pass' },
  },
  {
    name: 'a ranking, with positions in the leading column',
    results: [recorded.topRevenue2024],
    answer: [
      '| Rank | Company | Revenue |',
      '|---:|---|---:|',
      '| 1 | Walmart | $642.6B |',
      '| 2 | Amazon | $638.0B |',
      '| 3 | UnitedHealth | $400.3B |',
      '| 4 | Apple | $391.0B |',
      '| 5 | Google | $350.0B |',
    ].join('\n'),
    expect: { verdict: 'pass' },
  },
  {
    name: 'an ordinal in prose',
    results: [recorded.topRevenue2024],
    answer: 'Apple was the 4th largest by revenue, at **$391.0B**.',
    expect: { verdict: 'pass' },
  },
  {
    name: 'a year range in a chart title',
    results: [recorded.appleVsMicrosoft],
    answer: [
      'Apple led in both years, reaching **$383.3B**.',
      '',
      '```chart',
      '{"type":"line","title":"Revenue, 2022-2023","data":[{"year":2023,"revenue":383285000000}]}',
      '```',
    ].join('\n'),
    expect: { verdict: 'pass' },
  },
  {
    name: 'a sentence comma that is not a thousands separator',
    results: [recorded.appleVsMicrosoft],
    answer: 'Revenue rose in 2023, while the year before it had been lower.',
    expect: { verdict: 'pass' },
  },
  {
    name: 'a parenthesised year in a table heading',
    results: [recorded.sectorAverages],
    answer: ['| Sector | Average revenue (2024) |', '|---|---:|', '| Consumer | $157.3B |'].join(
      '\n',
    ),
    expect: { verdict: 'pass' },
  },
  {
    name: 'a figure the chart shows and the answer never writes down',
    results: [recorded.appleVsMicrosoft],
    answer: [
      '| Year | Revenue |',
      '|---|---:|',
      '| 2023 | $383.3B |',
      '',
      '```chart',
      '{"type":"bar","data":[{"year":2022,"revenue":394328000000}]}',
      '```',
    ].join('\n'),
    expect: { verdict: 'fail', reasons: ['value_mismatch'], gateReleases: true },
  },
  {
    name: 'unavailable: revenue that was never recorded',
    results: [recorded.goldmanRevenue],
    answer: "Goldman's revenue for 2023 is not available in this dataset.",
    expect: { verdict: 'pass', unavailable: true },
  },
  {
    name: 'unavailable: a figure invented for a value that is not recorded',
    results: [recorded.goldmanRevenue],
    answer: "Goldman's revenue in 2023 was **$45.0B**.",
    expect: { verdict: 'fail', reasons: ['no_evidence'], unavailable: true },
  },
  {
    name: 'unavailable: net income that was never recorded',
    results: [recorded.mastercardNetIncome],
    answer: "Mastercard's net income is not recorded in this dataset for 2024.",
    expect: { verdict: 'pass', unavailable: true },
  },
  {
    name: 'unavailable: a company outside the dataset',
    results: [recorded.emptyResult],
    answer: "Berkshire Hathaway's 2023 net income is not available in this dataset.",
    expect: { verdict: 'pass', unavailable: true },
  },
  {
    name: 'unavailable: a company outside the dataset, answered with a figure',
    results: [recorded.emptyResult],
    answer: "Berkshire Hathaway's 2023 net income was **$96.2B**.",
    expect: { verdict: 'fail', reasons: ['no_evidence'], unavailable: true },
  },
  {
    name: 'unavailable: a metric the dataset does not hold',
    results: [recorded.appleNetIncome],
    answer:
      "EPS is not available in this dataset. It holds Apple's 2023 net income of **$97.0B**, but no share count.",
    expect: { verdict: 'pass', unavailable: true },
  },
  {
    name: 'unavailable: a year a company does not have',
    results: [recorded.emptyResult],
    answer: 'Shopify revenue for 2022 is not available in this dataset.',
    expect: { verdict: 'pass', unavailable: true },
  },
  {
    name: 'unavailable: claimed without ever querying',
    results: [],
    answer: 'That data is not available.',
    expect: { verdict: 'fail', reasons: ['no_evidence'], unavailable: true },
  },
  {
    name: 'partial coverage at the early end: BlackRock has 2022 and 2023 only',
    results: [recorded.blackrockYears],
    answer: "BlackRock's 2023 revenue was **$17.9B**.",
    expect: { verdict: 'pass' },
  },
  {
    name: 'partial coverage at the late end: Shopify has 2024 and 2025 only',
    results: [recorded.shopifyYears],
    answer: "Shopify's 2024 revenue was **$8.9B**.",
    expect: { verdict: 'pass' },
  },
  {
    name: 'one display string, three companies behind it',
    results: [recorded.crowdedDisplay],
    answer: 'Each of them comes to about **$10.6B**.',
    expect: { verdict: 'pass' },
  },
  {
    name: 'no figures at all',
    results: [recorded.appleNetIncome],
    answer: 'Which company did you have in mind?',
    expect: { verdict: 'pass' },
  },
];

export const GOLDEN: readonly GoldenCase[] = [...WRITTEN, ...generated()];
