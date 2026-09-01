import { groundingReport, type GroundingReport, type Violation } from '@fca/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_DRAFTS,
  buildRepairInstruction,
  decideAfterVerification,
  type RepairDecision,
} from '../repair';

function reportWith(violations: readonly Violation[]): GroundingReport {
  return groundingReport.parse({
    verdict: violations.length === 0 ? 'pass' : 'fail',
    checkedClaims: [],
    violations,
  });
}

describe('what to do with a draft that has been verified', () => {
  it('accepts one that passed, whichever draft it was', () => {
    for (let drafts = 1; drafts <= MAX_DRAFTS + 2; drafts += 1) {
      expect(decideAfterVerification(reportWith([]), drafts)).toEqual({ kind: 'accept' });
    }
  });

  it('asks for another draft while there are drafts left', () => {
    const decision = decideAfterVerification(
      reportWith([{ text: '$85.2B', reason: 'no_evidence' }]),
      1,
    );

    expect(decision.kind).toBe('repair');
  });

  it('stops asking once the drafts are used up', () => {
    const failed = reportWith([{ text: '$85.2B', reason: 'no_evidence' }]);

    expect(decideAfterVerification(failed, MAX_DRAFTS - 1).kind).toBe('repair');
    expect(decideAfterVerification(failed, MAX_DRAFTS).kind).toBe('fallback');
    expect(decideAfterVerification(failed, MAX_DRAFTS + 1).kind).toBe('fallback');
  });

  it('allows exactly three drafts, counted the way a runner would count them', () => {
    // The number the comment on MAX_DRAFTS claims, written as the loop that
    // would actually spend the tokens. A caller starting its count at zero pays
    // for a fourth generation, and nothing in the type system would say so.
    const failed = reportWith([{ text: '$85.2B', reason: 'no_evidence' }]);
    let draftsProduced = 0;
    let decision: RepairDecision;

    do {
      draftsProduced += 1; // the model writes one
      decision = decideAfterVerification(failed, draftsProduced);
    } while (decision.kind === 'repair');

    expect(draftsProduced).toBe(MAX_DRAFTS);
    expect(decision.kind).toBe('fallback');
  });

  it('always reaches one of the three, for any report and any count', () => {
    // There is no state a generation can sit in forever. If a fourth branch is
    // ever added, this is where the absence of it stops being true.
    fc.assert(
      fc.property(fc.boolean(), fc.integer({ min: 1, max: 50 }), (passed, drafts) => {
        const report = reportWith(passed ? [] : [{ text: '$1.0B', reason: 'no_evidence' }]);
        const decision = decideAfterVerification(report, drafts);

        expect(['accept', 'repair', 'fallback']).toContain(decision.kind);
      }),
      { numRuns: 500 },
    );
  });
});

describe('what the model is told to fix', () => {
  it('names every figure that failed, and says something different about each', () => {
    const instruction = buildRepairInstruction([
      { text: '$85.2B', reason: 'no_evidence' },
      { text: '$96.9B', reason: 'value_mismatch' },
      { text: '$2,023', reason: 'unit_mismatch' },
      { text: '2019', reason: 'out_of_coverage' },
    ]);

    for (const text of ['$85.2B', '$96.9B', '$2,023', '2019']) {
      expect(instruction).toContain(text);
    }
    // Four reasons, four pieces of advice — a repair round told the same thing
    // about every failure is a repair round that learns nothing from the report.
    const advice = instruction.split('\n').filter((line) => line.startsWith('- '));
    expect(new Set(advice.map((line) => line.split(' ').slice(2).join(' '))).size).toBe(4);
  });

  it('does not hand the model the answer it was supposed to produce', () => {
    // The report carries no correct value, and inventing one here would be this
    // system writing the figure and then calling the model's output verified.
    const instruction = buildRepairInstruction([{ text: '$96.9B', reason: 'value_mismatch' }]);

    expect(instruction).not.toContain('96995000000');
    expect(instruction).not.toContain('$97.0B');
  });
});
