import { InvalidTransitionError } from '../errors';
import { Err, Ok, type Result } from '../result';

/**
 * The lifecycle of one attempt to produce an assistant message. What matters is
 * the shape of the graph, not the happy path: `settling` is the only edge into
 * `closed`, so nothing finishes without settling its budget reservation, and every
 * phase still reaches `settling`, so no failure leaves money on hold.
 * `./generation-phase.machine.spec.ts` walks the graph to prove both.
 */
export const GENERATION_PHASES = [
  'reserved',
  'streaming',
  'verifying',
  'repairing',
  'settling',
  'closed',
] as const;

export type GenerationPhase = (typeof GENERATION_PHASES)[number];

/** How a generation ended, recorded when it enters `settling`. */
export type GenerationOutcome =
  'answered' | 'answered_with_fallback' | 'stopped' | 'failed' | 'unverifiable';

const ALLOWED: Readonly<Record<GenerationPhase, readonly GenerationPhase[]>> = {
  reserved: ['streaming', 'settling'], // settling: a stop or outage before any token is spent
  streaming: ['streaming', 'verifying', 'settling'], // self-edge: the next tool round
  verifying: ['repairing', 'settling'],
  repairing: ['streaming', 'settling'],
  settling: ['closed'],
  closed: [],
};

export const INITIAL_GENERATION_PHASE: GenerationPhase = 'reserved';
export const TERMINAL_GENERATION_PHASE: GenerationPhase = 'closed';

export function canTransitionGeneration(from: GenerationPhase, to: GenerationPhase): boolean {
  return ALLOWED[from].includes(to);
}

export function nextGenerationPhases(from: GenerationPhase): readonly GenerationPhase[] {
  return ALLOWED[from];
}

export function transitionGeneration(
  from: GenerationPhase,
  to: GenerationPhase,
): Result<GenerationPhase, InvalidTransitionError> {
  if (!canTransitionGeneration(from, to)) {
    return Err(
      new InvalidTransitionError(`Generation cannot move from ${from} to ${to}.`, { from, to }),
    );
  }
  return Ok(to);
}
