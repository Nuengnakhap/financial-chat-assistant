import type { GroundingReport } from '@fca/contracts';
import {
  INITIAL_GENERATION_PHASE,
  expectOk,
  transitionGeneration,
  type GenerationOutcome,
  type GenerationPhase,
} from '@fca/domain';
import {
  MAX_DRAFTS,
  buildRepairInstruction,
  buildSafeFallback,
  decideAfterVerification,
  verify,
} from '@fca/grounding';
import { Inject, Injectable } from '@nestjs/common';

import type { AgentEvent } from './agent-events';
import { Draft, type Written } from './draft';
import { GenerationContextFactory, type GenerationContext } from './generation-context';
import { FINANCIAL_QUERY_TOOL, type FinancialQueryTool } from './ports/financial-query.tool.port';
import { LLM_GATEWAY, type LlmGateway } from './ports/llm-gateway.port';
import type { PastTurn } from './transcript';
import { Transcript } from './transcript';

/**
 * One question, however many drafts it takes.
 *
 * This is where the parts meet: the model writes, the tool answers, the gate
 * reads every character before a reader does, and the verifier reads the
 * finished draft. Nothing here decides what is true — it decides what happens
 * next, and there are only three answers. Send it. Write it again, saying what
 * was wrong. Or stop asking the model and answer from the rows themselves.
 *
 * Three drafts and then the rows: a model told exactly which figure is
 * unsupported usually fixes it next time, and one that has failed twice with
 * that feedback is failing at something being told does not reach.
 */

/**
 * Five rounds of asking the database inside one draft. Measured against the real
 * model: an ordinary question takes one, a question whose first query is refused
 * takes two, and one where the model reads its own result and disagrees with it
 * takes three. Five leaves room; a sixth has never been the round that answered.
 */
const MAX_TOOL_ROUNDS = 5;

/**
 * Wording chosen from a code rather than passed up from wherever it broke — the
 * same rule `DomainErrorFilter` follows for an HTTP response, and for the same
 * reason. What the provider said is in the log; what a person reads says what
 * happened to them and what to do about it.
 */
const MESSAGE_BY_CODE: Readonly<Record<'unavailable' | 'generation_failed', string>> = {
  unavailable: 'The assistant cannot answer questions right now. Please try again shortly.',
  generation_failed: 'Something went wrong while writing the answer. Please try asking again.',
};

export interface GenerationRequest {
  readonly question: string;
  /** Earlier turns, oldest first. Trimmed by the transcript, not by the caller. */
  readonly history: readonly PastTurn[];
}

@Injectable()
export class AgentRunner {
  constructor(
    @Inject(LLM_GATEWAY) private readonly gateway: LlmGateway,
    @Inject(FINANCIAL_QUERY_TOOL) private readonly tool: FinancialQueryTool,
    private readonly contexts: GenerationContextFactory,
  ) {}

  async *run(request: GenerationRequest, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const context = this.contexts.current();
    if (context === null) {
      // Without the catalog the model would be told nothing about what this
      // dataset covers, and would answer from memory. Refusing is the only
      // honest thing left.
      yield { type: 'error', code: 'unavailable', message: MESSAGE_BY_CODE.unavailable };
      return;
    }

    yield { type: 'generation_started', model: context.model };
    yield* this.generate(request, context, signal);
  }

  private async *generate(
    request: GenerationRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const transcript = new Transcript(context.systemPrompt, request.history, request.question);
    const draft = new Draft(this.gateway, this.tool, context);
    const attempt: Attempt = { transcript, context };
    let phase = move(INITIAL_GENERATION_PHASE, 'streaming');

    for (let draftsProduced = 1; draftsProduced <= MAX_DRAFTS; draftsProduced += 1) {
      const written = yield* draft.write(transcript, signal, MAX_TOOL_ROUNDS);
      const step = this.decide(written, attempt, draftsProduced);

      if (step.kind === 'finish') {
        yield* this.finish(phase, step);
        return;
      }

      // A draft that is going to be written again was read first — by the gate
      // as it streamed, or by the verifier at the end. The machine passes
      // through `verifying` to say so, and that is not bookkeeping: `verifying`
      // is the only phase with an edge to `repairing`, which is the machine
      // insisting nothing is rewritten except because something read it.
      phase = move(phase, 'verifying');

      // Sent even though the draft it describes is being thrown away: a reader
      // about to see the answer disappear is owed the reason, and it is the only
      // place the reason exists.
      if (step.report !== null) yield { type: 'verification', report: step.report };

      // The ceiling is enforced here rather than in each path that reaches it:
      // `decideAfterVerification` counts drafts for the verifier, and a draft the
      // gate stopped never reaches it. Without this the last one would announce
      // a repair round that is never going to be streamed.
      if (step.kind === 'fallback' || draftsProduced >= MAX_DRAFTS) break;

      phase = move(phase, 'repairing');
      yield { type: 'draft_reset', attempt: draftsProduced + 1, reason: 'unverifiable_claim' };
      transcript.appendRepairInstruction(step.instruction);
      phase = move(phase, 'streaming');
    }

    yield* this.fallback(transcript, context, phase);
  }

  /** What a finished draft means for the generation: send, repair, or give up. */
  private decide(written: Written, attempt: Attempt, draftsProduced: number): Step {
    if (written.kind === 'stopped') return finish('stopped', written.text);
    if (written.kind === 'failed') return finish('failed', '');
    // The model asked five times and never answered. There is nothing to
    // verify, and the rows it did fetch are the answer it could not write.
    if (written.kind === 'exhausted') return { kind: 'fallback', report: null };
    if (written.kind === 'violation') {
      // The gate stopped it mid-sentence, so there is no draft to verify — only
      // the one figure that ended it, which is what the model is told about.
      return {
        kind: 'repair',
        instruction: buildRepairInstruction([written.violation]),
        report: null,
      };
    }

    const report = verify(written.text, attempt.transcript.toolResults(), attempt.context.coverage);
    const decision = decideAfterVerification(report, draftsProduced);
    if (decision.kind === 'accept') return finish('answered', written.text, { report });
    if (decision.kind === 'fallback') return { kind: 'fallback', report };
    return { kind: 'repair', instruction: decision.instruction, report };
  }

  /**
   * An answer, a stop, or a failure. A draft nobody read — stopped, or an
   * endpoint that went away — settles straight from streaming; one that was read
   * passes through `verifying` first, carrying the report that says so.
   */
  private async *finish(from: GenerationPhase, step: Finish): AsyncGenerator<AgentEvent> {
    if (step.report === null) {
      yield* this.close(from, step);
      return;
    }

    const phase = move(from, 'verifying');
    yield { type: 'verification', report: step.report };
    yield* this.close(phase, step);
  }

  /**
   * The answer of last resort: the rows themselves, assembled by code that
   * cannot invent a figure — and verified like any other answer, because code
   * that assembles a table from a company called `3M` writes a digit into it.
   */
  private async *fallback(
    transcript: Transcript,
    context: GenerationContext,
    phase: GenerationPhase,
  ): AsyncGenerator<AgentEvent> {
    // Always reached from `verifying`: every way out of the loop passes through
    // it, because every draft that ends the loop was read by something.
    const results = transcript.toolResults();
    const text = buildSafeFallback(results, context.coverage);
    const report = verify(text, results, context.coverage);

    yield { type: 'text_delta', delta: text };
    yield { type: 'verification', report };
    yield* this.close(phase, finish('answered_with_fallback', text, { report }));
  }

  /**
   * Every generation leaves through here, which is what makes `settling` the
   * only way into `closed` — the machine's guarantee that nothing finishes with
   * a budget reservation still held.
   */
  private async *close(from: GenerationPhase, step: Finish): AsyncGenerator<AgentEvent> {
    move(move(from, 'settling'), 'closed');

    if (step.outcome === 'failed') {
      yield {
        type: 'error',
        code: 'generation_failed',
        message: MESSAGE_BY_CODE.generation_failed,
      };
    }
    yield await Promise.resolve({
      type: 'finished' as const,
      outcome: step.outcome,
      text: step.text,
      report: step.report,
    });
  }
}

/** One generation's two constants, so judging a draft takes one argument for them. */
interface Attempt {
  readonly transcript: Transcript;
  readonly context: GenerationContext;
}

interface Finish {
  readonly kind: 'finish';
  readonly outcome: GenerationOutcome;
  readonly text: string;
  readonly report: GroundingReport | null;
}

type Step =
  | Finish
  /** The report, when there was one: a draft the gate stopped was never read whole. */
  | { readonly kind: 'fallback'; readonly report: GroundingReport | null }
  | {
      readonly kind: 'repair';
      readonly instruction: string;
      readonly report: GroundingReport | null;
    };

function finish(
  outcome: GenerationOutcome,
  text: string,
  said: { readonly report?: GroundingReport } = {},
): Finish {
  return { kind: 'finish', outcome, text, report: said.report ?? null };
}

/**
 * A refused transition is a bug in this file rather than a state the system can
 * reach, so it throws where a `Result` would only be checked and rethrown.
 */
function move(from: GenerationPhase, to: GenerationPhase): GenerationPhase {
  return expectOk(transitionGeneration(from, to), 'the runner drove the generation machine');
}
