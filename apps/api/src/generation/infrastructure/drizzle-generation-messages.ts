import { groundingReport, messagePart, type MessageView } from '@fca/contracts';
import type { ConversationId, MessageId, MessageStatus, ReservationId, UserId } from '@fca/domain';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { DatabaseService } from '../../shared/persistence/database.service';
import { conversations, messages, usageEvents } from '../../shared/persistence/schema';
import type {
  Answer,
  FinishedAnswer,
  GenerationMessages,
  Question,
} from '../application/ports/generation-messages.port';
import type { PastTurn } from '../application/transcript';

/**
 * The generation context's own reads and writes against the message table.
 *
 * Every write here is conditional on the row still being `generating`. That is
 * the whole concurrency story for a finished answer: a runner persisting a
 * verified draft, a stop arriving a moment later and a janitor deciding the same
 * row was abandoned are three writers, and the condition means the first of them
 * decides and the others learn that they lost.
 */

/** Enough turns for a follow-up question to make sense, matching the transcript's own bound. */
const HISTORY_TURNS = 20;

const parts = z.array(messagePart);

@Injectable()
export class DrizzleGenerationMessages implements GenerationMessages {
  constructor(private readonly database: DatabaseService) {}

  async find(messageId: MessageId): Promise<Answer | null> {
    const [row] = await this.database.db
      .select(ANSWER_COLUMNS)
      .from(messages)
      // The owner comes from the conversation rather than from the message,
      // because a message has none of its own — and every guard on watching or
      // stopping a generation rests on this join.
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(messages.id, messageId))
      .limit(1);

    return row === undefined ? null : toAnswer(row);
  }

  /**
   * Read backwards from the answer and turned round, so the bound is on the
   * newest turns rather than on the oldest — a long conversation replays its end.
   */
  async questionFor(answer: Answer): Promise<Question | null> {
    const rows = await this.database.db
      .select({ role: messages.role, parts: messages.parts, status: messages.status })
      .from(messages)
      .where(and(eq(messages.conversationId, answer.conversationId), lt(messages.seq, answer.seq)))
      .orderBy(desc(messages.seq))
      .limit(HISTORY_TURNS + 1);

    const turns = rows.reverse().map(toTurn).filter(isSaid);
    const asked = turns.at(-1);
    if (asked?.role !== 'user') return null;

    return { text: asked.text, history: turns.slice(0, -1) };
  }

  /**
   * The row and the ledger entry in one transaction, because they are one fact:
   * an answer stored without its charge is a generation somebody got for
   * nothing, and a charge without an answer is money taken for one that never
   * existed. The ledger is what a window is rebuilt from when Redis has been
   * restarted, so it has to be exactly as true as the row it belongs to.
   */
  async finish(answer: FinishedAnswer): Promise<MessageView | null> {
    return await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .update(messages)
        .set({
          parts: answer.parts,
          status: answer.status,
          verification: answer.verification,
          model: answer.model,
          inputTokens: answer.inputTokens,
          cachedInputTokens: answer.cachedInputTokens,
          outputTokens: answer.outputTokens,
          costMicroUsd: answer.cost.micro,
        })
        .where(and(eq(messages.id, answer.messageId), eq(messages.status, 'generating')))
        .returning(VIEW_COLUMNS);

      // Lost the race to whoever ended this generation first, so there is
      // nothing to charge for either: their write carries their own figures.
      if (row === undefined) return null;

      if (answer.charge !== null) {
        await tx.insert(usageEvents).values({
          userId: answer.charge.userId,
          messageId: answer.messageId,
          windowStart: answer.charge.windowStart,
          model: answer.model,
          inputTokens: answer.inputTokens,
          cachedInputTokens: answer.cachedInputTokens,
          outputTokens: answer.outputTokens,
          costMicroUsd: answer.cost.micro,
        });
      }

      return toView(row);
    });
  }

  async view(messageId: MessageId): Promise<MessageView | null> {
    const [row] = await this.database.db
      .select(VIEW_COLUMNS)
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    return row === undefined ? null : toView(row);
  }

  async listAbandoned(startedBefore: Date): Promise<readonly Answer[]> {
    const rows = await this.database.db
      .select(ANSWER_COLUMNS)
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(messages.status, 'generating'), lt(messages.createdAt, startedBefore)))
      .orderBy(asc(messages.createdAt));

    return rows.map(toAnswer);
  }
}

const ANSWER_COLUMNS = {
  id: messages.id,
  conversationId: messages.conversationId,
  ownerId: conversations.userId,
  seq: messages.seq,
  status: messages.status,
  startedAt: messages.createdAt,
  reservationId: messages.reservationId,
  reservationWindow: messages.reservationWindow,
};

const VIEW_COLUMNS = {
  id: messages.id,
  conversationId: messages.conversationId,
  seq: messages.seq,
  role: messages.role,
  status: messages.status,
  parts: messages.parts,
  verification: messages.verification,
  model: messages.model,
  inputTokens: messages.inputTokens,
  cachedInputTokens: messages.cachedInputTokens,
  outputTokens: messages.outputTokens,
  costMicroUsd: messages.costMicroUsd,
  createdAt: messages.createdAt,
};

interface AnswerRow {
  id: string;
  conversationId: string;
  ownerId: string;
  seq: number;
  status: MessageStatus;
  startedAt: Date;
  reservationId: string | null;
  reservationWindow: Date | null;
}

interface ViewRow {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  status: MessageStatus;
  parts: unknown;
  verification: unknown;
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMicroUsd: bigint;
  createdAt: Date;
}

interface Turn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/* eslint-disable @typescript-eslint/consistent-type-assertions */
function toAnswer(row: AnswerRow): Answer {
  const ownerId = row.ownerId as UserId;

  return {
    ...row,
    id: row.id as MessageId,
    conversationId: row.conversationId as ConversationId,
    ownerId,
    // Both halves or neither, which `chk_reservation_is_whole` holds. Reading
    // it as a pair rather than as two nullable columns means nothing above here
    // has to wonder what half a claim would mean.
    reservation:
      row.reservationId === null || row.reservationWindow === null
        ? null
        : {
            userId: ownerId,
            id: row.reservationId as ReservationId,
            windowStart: row.reservationWindow,
          },
  };
}

function toView(row: ViewRow): MessageView {
  // Field by field rather than by spreading the row. The row carries columns
  // this view does not — among them a `bigint` cost — and a spread would put
  // them on an object that is JSON-encoded onto a stream, where a `bigint`
  // throws. The view is a shape of its own, so it is built as one.
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    role: row.role,
    status: row.status,
    // Parsed rather than asserted, both of them: these are `jsonb`, so their
    // shape is a claim about what was written rather than something the row can
    // prove, and half a rendered answer is worse than a loud refusal.
    parts: parts.parse(row.parts),
    verification: groundingReport.nullable().parse(row.verification ?? null),
    usage: usageOf(row),
    error: null,
    createdAt: row.createdAt.toISOString(),
  };
}
/* eslint-enable @typescript-eslint/consistent-type-assertions */

/**
 * What a message cost, or `null` for one that never ran a model — a question,
 * or an answer that failed before asking anything. Zero tokens and no model is
 * what "nothing was spent" looks like on the row, and reporting that as a usage
 * of zero would read as a measurement rather than as an absence.
 */
function usageOf(row: ViewRow): MessageView['usage'] {
  if (row.model === null || row.model === '') return null;

  return {
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    costMicroUsd: row.costMicroUsd.toString(),
  };
}

/**
 * Only what was said. A turn whose parts hold no text — an answer that failed
 * before writing anything, or one that is nothing but tool calls — would reach
 * the model as an empty message, which some providers refuse outright.
 */
function toTurn(row: { role: 'user' | 'assistant'; parts: unknown }): Turn {
  const said = parts.safeParse(row.parts);
  const text = said.success
    ? said.data
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join('')
    : '';

  return { role: row.role, text };
}

function isSaid(turn: Turn): turn is PastTurn {
  return turn.text !== '';
}
