import type { GroundingReport, MessagePart, MessageStatus, MessageView } from '@fca/contracts';
import { MicroUsd, type UserId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { USAGE_SETTLEMENT, type Charged, type UsageSettlement } from './ports/budget.port';
import {
  GENERATION_MESSAGES,
  type Answer,
  type GenerationMessages,
  type Question,
} from './ports/generation-messages.port';

/**
 * Everything a generation leaves written down: the row it ends in, what it cost,
 * and the counter that cost is charged against.
 *
 * They are one thing because the order between them is a rule rather than a
 * preference. The row is a conditional write, so it is what decides which of
 * several writers ended a generation — a runner finishing, a stop arriving, a
 * janitor clearing up after a process that died. Only that writer may move the
 * counter. Settling first would let a process that lost the row still charge
 * for it, and the ledger a window is rebuilt from would then disagree with the
 * counter it was rebuilding.
 */
export interface Ending {
  readonly status: Exclude<MessageStatus, 'generating'>;
  readonly parts: readonly MessagePart[];
  readonly verification: GroundingReport | null;
  readonly used: UsedTokensOf;
}

/** What the provider reported, plus whatever it left unsaid. */
interface UsedTokensOf {
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly unreportedText: string;
  readonly estimatedInputTokens: number;
}

export interface Closed {
  /** `null` when somebody else ended this generation first. */
  readonly stored: MessageView | null;
  readonly charged: Charged;
}

@Injectable()
export class AnswerBooks {
  constructor(
    @Inject(GENERATION_MESSAGES) private readonly messages: GenerationMessages,
    @Inject(USAGE_SETTLEMENT) private readonly budget: UsageSettlement,
  ) {}

  /** What was asked, and what was said before it. */
  async questionFor(answer: Answer): Promise<Question | null> {
    return await this.messages.questionFor(answer);
  }

  async close(answer: Answer, ending: Ending): Promise<Closed> {
    const charged = await this.budget.price(ending.used);
    const stored = await this.messages.finish({
      messageId: answer.id,
      status: ending.status,
      parts: ending.parts,
      verification: ending.verification,
      model: charged.model,
      inputTokens: charged.inputTokens,
      cachedInputTokens: charged.cachedInputTokens,
      outputTokens: charged.outputTokens,
      cost: charged.cost,
      charge:
        answer.reservation === null
          ? null
          : { userId: answer.ownerId, windowStart: answer.reservation.windowStart },
    });

    if (stored !== null && answer.reservation !== null) {
      await this.budget.settle(answer.reservation, charged.cost);
    }

    return { stored, charged };
  }

  /**
   * Ends a generation that never asked the model anything. The whole claim goes
   * back rather than being settled at nothing, which would leave a row in the
   * ledger saying a generation happened.
   */
  async giveUp(answer: Answer): Promise<MessageView | null> {
    const stored = await this.messages.finish({
      messageId: answer.id,
      status: 'error',
      parts: [],
      verification: null,
      model: '',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cost: MicroUsd.ZERO,
      charge: null,
    });

    if (stored !== null && answer.reservation !== null) {
      await this.budget.release(answer.reservation);
    }

    return stored;
  }

  /** What is left of the window, for the one event that reports it. */
  async remaining(userId: UserId): ReturnType<UsageSettlement['snapshot']> {
    return await this.budget.snapshot(userId);
  }
}
