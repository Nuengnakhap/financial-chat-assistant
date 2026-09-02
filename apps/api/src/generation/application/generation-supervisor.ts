import type { MessageId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import type { Answer } from './ports/generation-messages.port';
import { GENERATION_STOPS, type GenerationStops } from './ports/generation-stops.port';
import { RunGenerationUseCase } from './run-generation.use-case';
import { TaskRegistry } from '../../bootstrap/task-registry';

/**
 * What is being generated on this process, and what can end it.
 *
 * A generation is deliberately not the job that triggered it: the job returns
 * the moment the work is registered here, so a queue with four consumers is not
 * four generations wide, and a broker redelivering a job hours later does not
 * find one of its consumers still blocked on the first delivery.
 *
 * Two things can end a generation early and they arrive from opposite
 * directions: somebody pressing Stop, which comes over Redis and may have been
 * asked for on another pod, and this process shutting down, which comes from
 * `TaskRegistry` after it has waited. The work is given both as one signal,
 * because from inside there is nothing to tell them apart — either way it stops
 * writing, keeps what it has, and settles.
 */
@Injectable()
export class GenerationSupervisor {
  private readonly running = new Set<MessageId>();

  constructor(
    private readonly generate: RunGenerationUseCase,
    @Inject(GENERATION_STOPS) private readonly stops: GenerationStops,
    private readonly tasks: TaskRegistry,
  ) {}

  /**
   * False when nothing was started: the same generation is already running here,
   * or the process is shutting down and refusing new work. Neither is an error —
   * the row stays `generating` and the janitor is what notices if nobody picks
   * it up.
   */
  begin(answer: Answer): boolean {
    if (this.running.has(answer.id)) return false;
    this.running.add(answer.id);

    const started = this.tasks.spawn(`generation:${answer.id}`, async (shutdown) => {
      await this.work(answer, shutdown);
    });
    if (!started) this.running.delete(answer.id);

    return started;
  }

  private async work(answer: Answer, shutdown: AbortSignal): Promise<void> {
    const stopped = await this.stops.hold(answer.id);

    try {
      await this.generate.execute(answer, AbortSignal.any([shutdown, stopped]));
    } finally {
      // Both, always. A generation left in the set is one this process would
      // refuse to run again after a redelivery, and a channel left subscribed is
      // one it keeps listening on for a message that has already been answered.
      await this.stops.release(answer.id);
      this.running.delete(answer.id);
    }
  }
}
