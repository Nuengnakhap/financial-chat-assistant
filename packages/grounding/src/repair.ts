import type { GroundingReport, Violation } from '@fca/contracts';

/**
 * What to do with a draft that has been verified.
 *
 * A pure function of the report and how many drafts have been written, so the
 * runner that aborts streams and spends tokens holds no policy of its own. Every path
 * out of here ends somewhere: accept, try again with something specific to fix,
 * or stop trying and show the figures alone. There is no fourth branch where a
 * draft is neither accepted nor replaced, which is what keeps a generation from
 * having a state it can sit in forever.
 */

export type RepairDecision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'repair'; readonly instruction: string }
  | { readonly kind: 'fallback' };

/**
 * The first draft plus two more. A model told exactly which figure is wrong
 * usually fixes it on the next draft; one that has failed twice with that
 * feedback is failing at something being told does not reach, and a third round
 * spends a full generation to find out again.
 */
export const MAX_DRAFTS = 3;

/**
 * What to say about each kind of failure. Written for the model rather than for
 * a person: it is going into the transcript as feedback, and the more precisely
 * it names the fix, the fewer rounds it takes.
 */
const ADVICE: Readonly<Record<Violation['reason'], string>> = {
  no_evidence: 'does not appear in any query result. Remove it, or query for it first.',
  value_mismatch:
    'is close to a value in the results but not equal to one. Copy the display string from the tool result exactly, rather than rounding it again yourself.',
  unit_mismatch:
    'is written as one kind of quantity but the only matching value is another. An amount of money cannot be supported by a year, nor a percentage by a count of rows.',
  out_of_coverage:
    'is outside the years this dataset holds. Say plainly that the data is not there, and offer the years that are.',
};

/**
 * Names every figure that failed and why, and nothing else.
 *
 * It deliberately does not supply the right answer, because the report does not
 * carry one — `violation` is a text and a reason by design, so that what reaches
 * the model is what was measured rather than a correction inferred on its
 * behalf. The cost is the occasional extra round; the alternative is a system
 * that quietly writes the answer it wanted and calls the model's output verified.
 */
export function buildRepairInstruction(violations: readonly Violation[]): string {
  const listed = violations.map((violation) => `- ${violation.text} ${ADVICE[violation.reason]}`);

  return [
    'The previous answer was rejected because these figures could not be checked against the query results:',
    ...listed,
    'Write the answer again. Every figure must come from a tool result in this conversation.',
  ].join('\n');
}

/**
 * `draftsProduced` counts the drafts the model has written, *including* the one
 * this report is about — so it is one the first time round, never zero. It is
 * named for what it counts rather than called `attempt`, because a caller
 * reading "attempt" has an even chance of starting at zero, and the cost of
 * that reading is a fourth generation nobody meant to pay for.
 */
export function decideAfterVerification(
  report: GroundingReport,
  draftsProduced: number,
): RepairDecision {
  if (report.verdict === 'pass') return { kind: 'accept' };
  if (draftsProduced >= MAX_DRAFTS) return { kind: 'fallback' };

  return { kind: 'repair', instruction: buildRepairInstruction(report.violations) };
}
