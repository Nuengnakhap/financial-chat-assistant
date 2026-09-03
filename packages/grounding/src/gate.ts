import type { Violation } from '@fca/contracts';

import {
  couldOpenFence,
  extractNumericClaims,
  isFenceLine,
  isTableRowLine,
  settledPrefixOf,
} from './claims';
import type { Coverage } from './coverage';
import { buildEvidenceSet, type EvidenceSet } from './evidence';
import { REFUSAL_REACH, judge, refusalIn } from './judgement';
import type { ToolResult } from './tool-result';

/**
 * The filter the answer is written through, one delta at a time.
 *
 * Verifying a finished answer is too late to be the guarantee: by the time the
 * draft ends, an unsupported figure has already been on somebody's screen, and
 * no amount of correcting afterwards unsees it. So a figure is decided the
 * moment it is complete, and until then it is held — a few characters, long
 * enough for the number to finish and for whatever follows it to say what it
 * was.
 *
 * The one property that matters is that this cannot disagree with the verifier.
 * It is not established by testing every case but by construction: the gate
 * releases text only once the extractor's reading of it can no longer change,
 * and it asks the same `judge` the verifier asks. Chunking therefore cannot
 * affect the outcome, because nothing here looks at where a delta began or
 * ended — only at what the accumulated answer says so far.
 */

export type GateEvent =
  | { readonly kind: 'emit'; readonly text: string }
  | { readonly kind: 'violation'; readonly violation: Violation };

export interface Gate {
  /** Text that has been cleared for a reader, or the figure that stopped it. */
  push(delta: string): readonly GateEvent[];
  /** The model has finished. Whatever is still held is decided now. */
  flush(): readonly GateEvent[];
}

/**
 * A figure longer than this is not a figure. Nothing this system formats comes
 * close — the longest is a twenty-one character `numeric` — so a run of digits
 * past it is a model that has stopped producing sentences, and holding out for
 * an end that never comes would stall the stream instead of failing it.
 */
const MAX_HOLD = 48;

/** What is still open. Where it began does not matter — only that it has not closed. */
type Block = 'fence' | 'table';

interface Walk {
  readonly settled: number;
  readonly block: Block | null;
}

function stepOverLine(walk: Walk, line: string, at: number): Walk {
  const end = at + line.length + 1;

  // A fence means whatever is inside it, so nothing in it settles until the
  // closing line has said what kind of block it was.
  if (walk.block === 'fence') {
    return isFenceLine(line) ? { settled: end, block: null } : walk;
  }
  if (isFenceLine(line)) return { ...walk, block: 'fence' };

  // A row is a rank only if it falls inside the count of rows the table ends up
  // having, and that is not known until a line arrives that is not one.
  if (isTableRowLine(line)) return walk.block === null ? { ...walk, block: 'table' } : walk;

  return { settled: end, block: null };
}

function settleTrailing(walk: Walk, line: string, at: number): Walk {
  if (walk.block !== null) return walk;
  // Neither of these has ruled out starting a block, and a block changes what
  // its contents mean.
  if (isTableRowLine(line) || couldOpenFence(line)) return walk;

  const prefix = settledPrefixOf(line);
  return { ...walk, settled: at + (line.length - prefix > MAX_HOLD ? line.length : prefix) };
}

/** How much of the answer so far means what it will always mean. */
function settledLength(text: string): number {
  let walk: Walk = { settled: 0, block: null };
  let at = 0;

  while (at < text.length) {
    const feed = text.indexOf('\n', at);
    if (feed === -1) {
      walk = settleTrailing(walk, text.slice(at), at);
      break;
    }

    walk = stepOverLine(walk, text.slice(at, feed), at);
    at = feed + 1;
  }

  return walk.settled;
}

/**
 * Re-reading starts at the beginning of the line the last release stopped in,
 * never at the release point itself. A cut inside a line loses the line, and a
 * tail that happens to begin with a pipe would read as a table row that the
 * whole answer never contained.
 */
function lineStartAt(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

interface Rules {
  readonly evidence: EvidenceSet;
  readonly coverage: Coverage;
  /**
   * Nothing was asked at all, so a sentence saying this dataset cannot answer
   * rests on the model's reading of the catalog rather than on anything that
   * happened. That is a claim about the data as much as a figure is, and it
   * would reach a reader mid-sentence if the gate only watched numbers.
   */
  readonly groundless: boolean;
}

interface Stop {
  readonly at: number;
  readonly violation: Violation;
}

/** The stretch of the answer whose reading has settled but which is still held. */
interface Window {
  readonly from: number;
  readonly to: number;
}

/**
 * How far it is safe to release once the figures are taken into account: never
 * past the beginning of one that does not fit inside the window yet.
 *
 * Without this the window can be narrower than a figure and the figure is
 * skipped rather than held — `break` leaves it unjudged, the release moves past
 * it anyway, and on the next pass it begins before the window and is skipped
 * again, for good. Measured: a figure in an answer written without asking
 * anything reached the screen in full, one character at a time, because the
 * refusal-phrase reach held the window to a single character while the release
 * point advanced through it.
 *
 * Clamping instead of skipping restores what the rest of this file assumes —
 * that text is released only once its reading has been decided.
 */
function heldFrom(text: string, window: Window): number {
  const from = lineStartAt(text, window.from);

  for (const literal of extractNumericClaims(text.slice(from))) {
    const at = from + literal.at;
    if (at + literal.text.length > window.to) return Math.max(window.from, Math.min(window.to, at));
  }

  return window.to;
}

function firstBadFigure(rules: Rules, text: string, window: Window): Stop | null {
  const from = lineStartAt(text, window.from);

  for (const literal of extractNumericClaims(text.slice(from))) {
    const at = from + literal.at;
    if (at < window.from) continue;
    if (at + literal.text.length > window.to) break;

    const judgement = judge(literal, rules.evidence, rules.coverage);
    if (judgement.kind === 'violation') return { at, violation: judgement.violation };
  }

  return null;
}

/**
 * A refusal is looked for across the whole answer rather than only inside the
 * window, because the point of watching it is to stop before it is written out —
 * and `reachOf` is what guarantees it has not been.
 */
function firstStop(rules: Rules, text: string, window: Window): Stop | null {
  const refusal = rules.groundless ? refusalIn(text) : null;
  if (refusal !== null) return { at: refusal.at, violation: refusal.violation };

  return firstBadFigure(rules, text, window);
}

/** How far it is safe to release, once the refusal phrase is also being watched. */
function reachOf(text: string, groundless: boolean, final: boolean): number {
  if (final) return text.length;
  const settled = settledLength(text);

  return groundless ? Math.min(settled, Math.max(0, text.length - REFUSAL_REACH)) : settled;
}

export function openGate(results: readonly ToolResult[], coverage: Coverage): Gate {
  const rules: Rules = {
    evidence: buildEvidenceSet(results),
    coverage,
    groundless: results.length === 0,
  };
  let text = '';
  let released = 0;
  let stopped = false;

  const advance = (final: boolean): readonly GateEvent[] => {
    if (stopped) return [];

    const reach = reachOf(text, rules.groundless, final);
    // Two limits, and the narrower wins: how much of the answer means what it
    // will always mean, and how much of it has been decided.
    const to = heldFrom(text, { from: released, to: reach });
    const stop = firstStop(rules, text, { from: released, to: reach });
    const upto = stop === null ? to : Math.max(released, stop.at);
    const cleared = text.slice(released, upto);

    released = upto;
    stopped = stop !== null;
    const shown: readonly GateEvent[] = cleared === '' ? [] : [{ kind: 'emit', text: cleared }];

    return stop === null ? shown : [...shown, { kind: 'violation', violation: stop.violation }];
  };

  return {
    push(delta: string): readonly GateEvent[] {
      text += delta;
      return advance(false);
    },
    flush(): readonly GateEvent[] {
      return advance(true);
    },
  };
}
