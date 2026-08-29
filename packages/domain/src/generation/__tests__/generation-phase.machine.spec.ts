import { describe, expect, it } from 'vitest';

import { InvalidTransitionError } from '../../errors';
import { isErr, isOk } from '../../result';
import {
  GENERATION_PHASES,
  INITIAL_GENERATION_PHASE,
  TERMINAL_GENERATION_PHASE,
  canTransitionGeneration,
  nextGenerationPhases,
  transitionGeneration,
  type GenerationPhase,
} from '../generation-phase.machine';

/** Breadth-first walk of the transition table. */
function reachableFrom(start: GenerationPhase): Set<GenerationPhase> {
  const seen = new Set<GenerationPhase>();
  const queue: GenerationPhase[] = [start];

  while (queue.length > 0) {
    const phase = queue.shift();
    if (phase === undefined || seen.has(phase)) continue;
    seen.add(phase);
    queue.push(...nextGenerationPhases(phase));
  }
  return seen;
}

describe('individual transitions', () => {
  it('accepts an edge that exists', () => {
    const result = transitionGeneration('reserved', 'streaming');
    expect(isOk(result) && result.value).toBe('streaming');
  });

  it('rejects an edge that does not, naming both ends', () => {
    const result = transitionGeneration('reserved', 'closed');

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toBeInstanceOf(InvalidTransitionError);
    expect(result.error.details).toEqual({ from: 'reserved', to: 'closed' });
  });

  it('lets streaming loop for another tool round', () => {
    expect(canTransitionGeneration('streaming', 'streaming')).toBe(true);
  });

  it('never leaves the terminal phase', () => {
    expect(nextGenerationPhases(TERMINAL_GENERATION_PHASE)).toEqual([]);
  });
});

describe('the invariants that make a leaked reservation impossible', () => {
  it('lets only settling close a generation, so budget is always released', () => {
    // G2: if any other phase could reach `closed`, a crash there would hold the
    // reservation until the window expired.
    const canClose = GENERATION_PHASES.filter((phase) => canTransitionGeneration(phase, 'closed'));

    expect(canClose).toEqual(['settling']);
  });

  it('can still reach settling from every open phase, so nothing gets stuck', () => {
    const open = GENERATION_PHASES.filter((phase) => phase !== TERMINAL_GENERATION_PHASE);

    for (const phase of open) {
      expect(reachableFrom(phase).has('settling')).toBe(true);
    }
  });

  it('reaches every phase from the initial one, so none is dead code', () => {
    expect(reachableFrom(INITIAL_GENERATION_PHASE)).toEqual(new Set(GENERATION_PHASES));
  });

  it('cannot re-enter the initial phase, so a reservation is never taken twice', () => {
    const reEntrant = GENERATION_PHASES.filter((phase) =>
      canTransitionGeneration(phase, INITIAL_GENERATION_PHASE),
    );

    expect(reEntrant).toEqual([]);
  });

  it('allows an immediate abort: reserve, then settle without spending a token', () => {
    // A stop or outage before the first token must not be forced through streaming.
    expect(canTransitionGeneration('reserved', 'settling')).toBe(true);
  });
});

describe('the shape of the table', () => {
  it('lists exactly the phases the table defines', () => {
    expect(GENERATION_PHASES).toHaveLength(6);
    for (const phase of GENERATION_PHASES) {
      expect(() => nextGenerationPhases(phase)).not.toThrow();
    }
  });

  it('never names a phase that is not in the list', () => {
    const known = new Set(GENERATION_PHASES);
    for (const phase of GENERATION_PHASES) {
      for (const next of nextGenerationPhases(phase)) {
        expect(known.has(next)).toBe(true);
      }
    }
  });
});
