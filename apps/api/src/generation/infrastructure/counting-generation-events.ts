import type { StreamEvent } from '@fca/contracts';
import type { MessageId } from '@fca/domain';
import { Injectable } from '@nestjs/common';

import { GenerationStream } from './generation-stream';
import { Counters } from '../../shared/observability/counters';
import type {
  GenerationEvents,
  StoredStreamEvent,
} from '../application/ports/generation-events.port';

/**
 * Counts what the answer to a question turned out to be, on its way past.
 *
 * A decorator rather than a dependency of the runner, and that is the point:
 * every generation event already flows through one place on its way to a
 * reader, so counting them costs no constructor parameter anywhere and no file
 * that produces an event has to know a counter exists. Take this binding out
 * and the system behaves identically, minus the numbers — which is the test of
 * whether observability has been bolted on or woven in.
 *
 * Two events say a draft was refused, and they are not the same refusal:
 * `draft_reset` is the claim gate stopping a figure mid-sentence, and a
 * `verification` that failed is the verifier reading a finished draft. A gate
 * violation produces no report at all, so counting only reports would miss the
 * half that matters most.
 */
@Injectable()
export class CountingGenerationEvents implements GenerationEvents {
  constructor(
    private readonly inner: GenerationStream,
    private readonly counters: Counters,
  ) {}

  async append(messageId: MessageId, event: StreamEvent): Promise<void> {
    // Written first, counted second. Counting first records something that
    // never happened when the write throws — and a number that is wrong in the
    // direction of "more than really occurred" is the one a reader trusts.
    await this.inner.append(messageId, event);

    if (event.type === 'draft_reset') this.counters.count('generation.draft_reset');
    if (event.type === 'verification' && event.report.verdict === 'fail') {
      this.counters.count('grounding.violation');
    }
  }

  read(
    messageId: MessageId,
    afterId: string,
    signal: AbortSignal,
  ): AsyncGenerator<StoredStreamEvent> {
    return this.inner.read(messageId, afterId, signal);
  }

  async replay(messageId: MessageId): Promise<readonly StoredStreamEvent[]> {
    return await this.inner.replay(messageId);
  }

  async lastActivityAt(messageId: MessageId): Promise<Date | null> {
    return await this.inner.lastActivityAt(messageId);
  }
}
