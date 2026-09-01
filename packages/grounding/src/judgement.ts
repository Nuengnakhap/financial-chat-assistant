import type { Claim, Violation } from '@fca/contracts';

import type { NumericLiteral } from './claims';
import { coversYear, type Coverage } from './coverage';
import { bandOf, neighbourhoodOf, type Reading } from './display';
import type { EvidenceSet, Support } from './evidence';
import { roundToInteger } from './quantity';

/**
 * What one figure in an answer turns out to be.
 *
 * It lives on its own because two callers must never disagree about it. The
 * streaming gate decides a figure the moment it is complete, so that an
 * unsupported one never reaches a reader; the verifier decides the same figures
 * again over the finished text. If those were two implementations of the same
 * rule they would drift, and the drift would show up as an answer the gate let
 * through and the report then called a violation — or worse, the other way
 * round. There is one implementation, and the two callers differ only in *when*
 * they call it.
 */

export type Judgement =
  | { readonly kind: 'claim'; readonly claim: Claim }
  | { readonly kind: 'violation'; readonly violation: Violation }
  | { readonly kind: 'structure' };

const STRUCTURE: Judgement = { kind: 'structure' };

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

export function judge(
  literal: NumericLiteral,
  evidence: EvidenceSet,
  coverage: Coverage,
): Judgement {
  if (literal.role === 'rank') return STRUCTURE;
  if (literal.role === 'year') return judgeYear(literal, coverage);

  return judgeFigure(literal, evidence, coverage);
}

/**
 * A sentence saying this dataset cannot answer. Deliberately a small set of
 * fixed phrases rather than anything cleverer: the prompt asks for exactly this
 * wording, and a looser pattern would start reading intent out of prose, which
 * is the kind of judgement this package refuses to make.
 */
const UNAVAILABLE =
  /\bnot available\b|\bno data\b|\bdoes not (?:include|contain|have)\b|\bnot in (?:this|the) dataset\b/iu;

export interface Refusal {
  readonly violation: Violation;
  /** Where the phrase begins, so a stream can stop short of it. */
  readonly at: number;
}

/**
 * Saying the dataset cannot answer is itself a claim about the dataset, and one
 * made without running a query rests on nothing but the model's reading of the
 * catalog. Querying first costs one round and turns it into a fact about an
 * empty result, which is why the prompt asks for it.
 *
 * Only ever asked when no query ran at all — a call that came back empty, or
 * came back an error, is a query that ran.
 */
export function refusalIn(markdown: string): Refusal | null {
  const said = UNAVAILABLE.exec(markdown);
  if (said === null) return null;

  return { violation: { text: said[0], reason: 'no_evidence' }, at: said.index };
}
