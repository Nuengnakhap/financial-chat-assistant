import type { Claim, GroundingReport, Violation } from '@fca/contracts';

import { extractNumericClaims, type NumericLiteral } from './claims';
import type { Coverage } from './coverage';
import { bandOf, contains, valueOf } from './display';
import { buildEvidenceSet, type EvidenceSet } from './evidence';
import { judge, refusalIn } from './judgement';
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

export function verify(
  markdown: string,
  results: readonly ToolResult[],
  coverage: Coverage,
): GroundingReport {
  const evidence = buildEvidenceSet(results);
  const literals = extractNumericClaims(markdown);

  const checkedClaims: Claim[] = [];
  // A query that ran and came back empty is still a query that ran; only having
  // asked nothing at all makes a refusal groundless.
  const refusal = results.length === 0 ? refusalIn(markdown) : null;
  const violations: Violation[] = [
    ...(refusal === null ? [] : [refusal.violation]),
    ...chartDisagreements(literals, evidence),
  ];

  for (const literal of literals) {
    const judgement = judge(literal, evidence, coverage);
    if (judgement.kind === 'claim') checkedClaims.push(judgement.claim);
    if (judgement.kind === 'violation') violations.push(judgement.violation);
  }

  return { verdict: violations.length === 0 ? 'pass' : 'fail', checkedClaims, violations };
}
