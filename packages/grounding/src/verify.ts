import type { Claim, GroundingReport, Violation } from '@fca/contracts';

import { extractNumericClaims, type NumericLiteral } from './claims';
import { coversYear, type Coverage } from './coverage';
import { bandOf, contains, neighbourhoodOf, valueOf, type Reading } from './display';
import { buildEvidenceSet, type EvidenceSet, type Support } from './evidence';
import { roundToInteger } from './quantity';
import type { ToolResult } from './tool-result';

/**
 * The whole answer, judged once, after it is finished.
 *
 * The streaming gate decides a figure the moment it is complete, which is what
 * keeps an unsupported one from ever reaching a reader. This runs afterwards
 * over the finished text, and it is not a formality: some mistakes are only
 * visible once there is a whole answer to look at — a chart disagreeing with the
 * table above it, or a claim that the data is unavailable made without ever
 * having looked. Sweeping the claims a second time also means a hole in the
 * gate's tokenizer is caught here rather than shipped.
 *
 * Nothing in it is a model. Every verdict is a comparison between text and
 * query results, so it is reproducible, explainable down to the figure, and
 * costs no tokens.
 */

/** What a single literal turned out to be. */
type Judgement =
  | { readonly kind: 'claim'; readonly claim: Claim }
  | { readonly kind: 'violation'; readonly violation: Violation }
  | { readonly kind: 'structure' };

const STRUCTURE: Judgement = { kind: 'structure' };

/**
 * A sentence saying this dataset cannot answer. Deliberately a small set of
 * fixed phrases rather than anything cleverer: the prompt asks for exactly this
 * wording, and a looser pattern would start reading intent out of prose, which
 * is the kind of judgement this package refuses to make.
 */
const UNAVAILABLE =
  /\bnot available\b|\bno data\b|\bdoes not (?:include|contain|have)\b|\bnot in (?:this|the) dataset\b/iu;

/** What kind of number a support holds, or `unknown` when the column is an alias. */
function unitOf(support: Support, coverage: Coverage): Reading['kind'] | 'unknown' {
  if (support.origin === 'growth') return 'percent';
  if (support.origin === 'row-count') return 'plain';

  return coverage.columns.get(support.column) ?? 'unknown';
}

/**
 * A bare number may be supported by anything — that is what the chart fence is
 * full of. A figure written as money or as a percentage may not be supported by
 * something of the other kind, which is what stops `$2,023` finding its evidence
 * in a year column and `5%` finding it in a row count.
 */
function fits(reading: Reading, support: Support, coverage: Coverage): boolean {
  const unit = unitOf(support, coverage);
  return reading.kind === 'plain' || unit === 'unknown' || unit === reading.kind;
}

function claimFrom(literal: NumericLiteral, support: Support): Claim {
  return {
    text: literal.text,
    value: roundToInteger(support.value).toString(),
    toolCallId: support.toolCallId,
    column: support.column,
    // A row count has no row of its own, and only exists when there is at least
    // one row to count, so the first row is where it points.
    rowIndex: support.rows[0] ?? 0,
  };
}

function unsupported(literal: NumericLiteral, evidence: EvidenceSet): Violation {
  // Near a real value means a digit was misread and the repair round has
  // something to correct; near nothing means the figure was invented.
  const nearby = evidence.match(neighbourhoodOf(literal.reading));
  return { text: literal.text, reason: nearby.length > 0 ? 'value_mismatch' : 'no_evidence' };
}

function judgeFigure(
  literal: NumericLiteral,
  evidence: EvidenceSet,
  coverage: Coverage,
): Judgement {
  const supports = evidence.match(bandOf(literal.reading));
  if (supports.length === 0)
    return { kind: 'violation', violation: unsupported(literal, evidence) };

  // Nearest first, so the one named is the closest of those that fit.
  const support = supports.find((candidate) => fits(literal.reading, candidate, coverage));
  if (support === undefined) {
    return { kind: 'violation', violation: { text: literal.text, reason: 'unit_mismatch' } };
  }

  return { kind: 'claim', claim: claimFrom(literal, support) };
}

/**
 * A year is structure, not a figure — but only if it is a year this dataset has.
 * One outside the coverage is a statement about data that does not exist, and it
 * has its own reason so the answer says which of the two went wrong.
 */
function judgeYear(literal: NumericLiteral, coverage: Coverage): Judgement {
  if (coversYear(coverage, literal.reading.ticks)) return STRUCTURE;

  return { kind: 'violation', violation: { text: literal.text, reason: 'out_of_coverage' } };
}

function judge(literal: NumericLiteral, evidence: EvidenceSet, coverage: Coverage): Judgement {
  if (literal.role === 'rank') return STRUCTURE;
  if (literal.role === 'year') return judgeYear(literal, coverage);

  return judgeFigure(literal, evidence, coverage);
}

/**
 * A figure drawn in a chart must also be one the reader can see written down.
 * A graph disagreeing with the table above it is wrong in the way that is
 * hardest to notice, because the eye takes the shape and not the number.
 *
 * Only values that already have evidence are considered here: one without is
 * a violation the claim sweep has reported, and saying it twice would tell a
 * repair round to fix one figure in two different ways. What is left is the case
 * this check exists for — a real number from the results, plotted, that the
 * answer never writes down, which given a prompt asking for a table beside every
 * chart means the two do not agree.
 *
 * The direction matters: a table may hold more than the chart plots, so only the
 * chart is held to the text. What this cannot see is a value plotted under the
 * wrong label — every number would be real and only the pairing wrong, and
 * telling which row a datum belongs to needs the chart's own structure rather
 * than the numbers in it.
 */
function chartDisagreements(
  literals: readonly NumericLiteral[],
  evidence: EvidenceSet,
): Violation[] {
  const figures = literals.filter((literal) => literal.role === 'figure');
  const drawn = figures.filter((literal) => literal.context === 'chart');
  const written = figures.filter((literal) => literal.context !== 'chart');
  if (drawn.length === 0 || written.length === 0) return [];

  return drawn
    .filter((literal) => evidence.match(bandOf(literal.reading)).length > 0)
    .filter(
      (literal) =>
        !written.some((shown) => contains(bandOf(shown.reading), valueOf(literal.reading))),
    )
    .map((literal) => ({ text: literal.text, reason: 'value_mismatch' }));
}

/**
 * Saying the dataset cannot answer is itself a claim about the dataset, and one
 * made without running a query rests on nothing but the model's reading of the
 * catalog. Querying first costs one round and turns it into a fact about an
 * empty result, which is why the prompt asks for it.
 */
function unfoundedRefusal(markdown: string, results: readonly ToolResult[]): Violation[] {
  if (results.length > 0) return [];

  const said = UNAVAILABLE.exec(markdown);
  return said === null ? [] : [{ text: said[0], reason: 'no_evidence' }];
}

export function verify(
  markdown: string,
  results: readonly ToolResult[],
  coverage: Coverage,
): GroundingReport {
  const evidence = buildEvidenceSet(results);
  const literals = extractNumericClaims(markdown);

  const checkedClaims: Claim[] = [];
  const violations: Violation[] = [
    ...unfoundedRefusal(markdown, results),
    ...chartDisagreements(literals, evidence),
  ];

  for (const literal of literals) {
    const judgement = judge(literal, evidence, coverage);
    if (judgement.kind === 'claim') checkedClaims.push(judgement.claim);
    if (judgement.kind === 'violation') violations.push(judgement.violation);
  }

  return { verdict: violations.length === 0 ? 'pass' : 'fail', checkedClaims, violations };
}
