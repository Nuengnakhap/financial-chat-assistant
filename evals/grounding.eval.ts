import { describe, expect, it } from 'vitest';

import { openGate, verify, type GateEvent } from '@fca/grounding';

import { COVERAGE, GOLDEN, type GoldenCase } from './golden/cases';

/**
 * The gate on grounding quality, run on every change.
 *
 * Unit tests ask whether each piece behaves; this asks whether the assembled
 * thing gets the right answer about a corpus of answers, and reports how right.
 * The numbers are printed rather than only asserted, because a suite that has
 * quietly slipped from a hundred per cent to ninety-six is worth seeing before
 * it drops under whatever threshold was chosen.
 *
 * Deterministic throughout: recorded query results, no model, no network, no
 * database. What a real model does with real prompts is a different measurement
 * and needs the generation pipeline to exist first.
 */

interface Outcome {
  readonly name: string;
  readonly verdictCorrect: boolean;
  readonly reasonsCorrect: boolean;
  readonly gateAgrees: boolean;
  readonly unavailable: boolean;
  readonly microseconds: number;
}

function emitted(events: readonly GateEvent[]): string {
  return events
    .filter((event) => event.kind === 'emit')
    .map((event) => event.text)
    .join('');
}

/**
 * The answer through the gate, one delta at a time, then what came out.
 *
 * Nine is not a special number: it is a chunk size that lands mid-word, mid-
 * figure and mid-line, which is the point. The property that any chunking gives
 * the same result is proved where the gate lives; here it is exercised on the
 * corpus so that a case the gate and the verifier disagree about is caught by
 * the same run that measures the verdicts.
 */
function throughGate(kase: GoldenCase): { readonly text: string; readonly stopped: boolean } {
  const gate = openGate(kase.results, COVERAGE);
  const events: GateEvent[] = [];
  for (let at = 0; at < kase.answer.length; at += 9) {
    events.push(...gate.push(kase.answer.slice(at, at + 9)));
  }
  events.push(...gate.flush());

  return { text: emitted(events), stopped: events.some((event) => event.kind === 'violation') };
}

function run(kase: GoldenCase): Outcome {
  const started = performance.now();
  const report = verify(kase.answer, kase.results, COVERAGE);
  const elapsed = performance.now() - started;

  const gate = throughGate(kase);
  const shouldPass = kase.expect.verdict === 'pass';

  return {
    name: kase.name,
    verdictCorrect: report.verdict === kase.expect.verdict,
    reasonsCorrect:
      kase.expect.reasons === undefined ||
      JSON.stringify(report.violations.map((violation) => violation.reason)) ===
        JSON.stringify(kase.expect.reasons),
    // Agreement in both directions: an answer the verifier accepts comes out
    // whole, and one it rejects was stopped rather than shown. The exception is
    // a case that fails only on a property of the whole answer, which the gate
    // cannot see one figure at a time — there, every figure it released was
    // supported, and releasing them was correct.
    gateAgrees:
      shouldPass || kase.expect.gateReleases === true
        ? gate.text === kase.answer && !gate.stopped
        : gate.stopped,
    unavailable: kase.expect.unavailable === true,
    microseconds: elapsed * 1_000,
  };
}

const OUTCOMES: readonly Outcome[] = GOLDEN.map(run);

function rate(of: readonly Outcome[], holds: (outcome: Outcome) => boolean): number {
  return of.length === 0 ? 1 : of.filter(holds).length / of.length;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function percentileMicroseconds(at: number): number {
  const sorted = OUTCOMES.map((outcome) => outcome.microseconds).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? 0;
}

const unavailableCases = OUTCOMES.filter((outcome) => outcome.unavailable);

/** Printed once, so a slip shows up as a number before it shows up as a failure. */
function report(): string {
  const p95 = percentileMicroseconds(0.95) / 1_000;

  return [
    '',
    `  grounding eval — ${String(OUTCOMES.length)} cases, ${String(unavailableCases.length)} of them about data the dataset does not hold`,
    '',
    `    verdict accuracy      ${percent(rate(OUTCOMES, (o) => o.verdictCorrect))}`,
    `    reason accuracy       ${percent(rate(OUTCOMES, (o) => o.reasonsCorrect))}`,
    `    gate agreement        ${percent(rate(OUTCOMES, (o) => o.gateAgrees))}`,
    `    unavailable recall    ${percent(rate(unavailableCases, (o) => o.verdictCorrect))}`,
    `    p95 verification      ${p95.toFixed(3)} ms`,
    '',
    '    repair rate and fallback rate need a model to mean anything: they are',
    '    how often a real draft has to be redone, and this suite has no drafts.',
    '    They arrive with the generation pipeline.',
    '',
  ].join('\n');
}

function failing(holds: (outcome: Outcome) => boolean): readonly string[] {
  return OUTCOMES.filter((outcome) => !holds(outcome)).map((outcome) => outcome.name);
}

describe('the grounding eval', () => {
  it('reports where it stands', () => {
    // eslint-disable-next-line no-console -- the report is the point of the suite
    console.log(report());

    expect(OUTCOMES.length).toBeGreaterThanOrEqual(80);
  });

  it('reaches the right verdict on every case', () => {
    expect(failing((outcome) => outcome.verdictCorrect)).toEqual([]);
  });

  it('gives the right reason wherever a case names one', () => {
    // A verdict that is right for the wrong reason tells a repair round to fix
    // the wrong thing, so this is a gate and not a statistic.
    expect(failing((outcome) => outcome.reasonsCorrect)).toEqual([]);
  });

  it('agrees with itself: what the gate released is what the verifier accepted', () => {
    expect(failing((outcome) => outcome.gateAgrees)).toEqual([]);
  });

  it('never misses a question this dataset cannot answer', () => {
    // The one metric that is a hard gate rather than a target. Saying something
    // confident about data that is not there is the worst failure available to
    // this system, so it is the failure with no tolerance at all.
    expect(unavailableCases.length).toBeGreaterThan(0);
    expect(rate(unavailableCases, (outcome) => outcome.verdictCorrect)).toBe(1);
  });

  it('verifies an answer fast enough to do it on every draft', () => {
    expect(percentileMicroseconds(0.95) / 1_000).toBeLessThan(15);
  });
});
