import type { MessageView } from '@fca/contracts';
import { ConversationId, MessageId, ReservationId, UserId } from '@fca/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { budgetDouble, type BudgetDouble } from './budget-double';
import type { GenerationEvents, StoredStreamEvent } from '../ports/generation-events.port';
import type { Answer, GenerationMessages } from '../ports/generation-messages.port';
import { EndAbandonedGenerationsUseCase } from '../use-cases/end-abandoned-generations.use-case';

/**
 * The last thing standing between a dead process and a conversation nobody can
 * ever use again. At most one generation runs per conversation, so a row left
 * `generating` by a pod that stopped existing does not merely leave a mess — it
 * blocks that conversation for good.
 */

const NOW = new Date('2026-09-02T12:00:00.000Z');
const LONG_AGO = new Date('2026-09-02T11:50:00.000Z');
const A_MOMENT_AGO = new Date('2026-09-02T11:59:50.000Z');

const ANSWER: Answer = {
  id: MessageId.trusted('a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d'),
  conversationId: ConversationId.trusted('cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21'),
  ownerId: UserId.trusted('e5c9f4a1-1f0e-4a6a-9d4e-0c8b6a3f21d0'),
  seq: 2,
  status: 'generating',
  startedAt: LONG_AGO,
  reservation: {
    userId: UserId.trusted('e5c9f4a1-1f0e-4a6a-9d4e-0c8b6a3f21d0'),
    id: ReservationId.trusted('2f1c2a1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b'),
    windowStart: new Date('2026-09-02T11:00:00.000Z'),
  },
};

/** A whole view, because the contract's own refinement insists on one. */
const STORED: MessageView = {
  id: ANSWER.id,
  conversationId: ANSWER.conversationId,
  seq: ANSWER.seq,
  role: 'assistant',
  status: 'stopped',
  parts: [],
  verification: null,
  usage: null,
  error: null,
  createdAt: LONG_AGO.toISOString(),
};

const listAbandoned = vi.fn();
const finish = vi.fn();
const lastActivityAt = vi.fn();
const replay = vi.fn();
const append = vi.fn();

const messages = { listAbandoned, finish } as unknown as GenerationMessages;
const events = { lastActivityAt, replay, append } as unknown as GenerationEvents;

let budget: BudgetDouble;

const sweep = () => new EndAbandonedGenerationsUseCase(messages, events, budget).execute(NOW);

const seen = (...events_: StoredStreamEvent['event'][]): StoredStreamEvent[] =>
  events_.map((event, index) => ({ id: `${String(index + 1)}-0`, event }));

beforeEach(() => {
  budget = budgetDouble();
  vi.resetAllMocks();
  listAbandoned.mockResolvedValue([ANSWER]);
  lastActivityAt.mockResolvedValue(null);
  replay.mockResolvedValue([]);
  finish.mockResolvedValue(STORED);
  append.mockResolvedValue(undefined);
});

describe('a generation nothing is writing any more', () => {
  it('is ended as stopped, and said to be over on its own stream', async () => {
    const ended = await sweep();

    expect(ended).toEqual([ANSWER.id]);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
    // A client watching it is still waiting for a terminal event, and the row
    // changing under it says nothing to a stream.
    expect(append).toHaveBeenCalledWith(ANSWER.id, {
      type: 'message_complete',
      message: STORED,
    });
  });

  it('keeps what the person had already been shown', async () => {
    replay.mockResolvedValue(
      seen(
        { type: 'tool_call_ready', id: 'call_1', sql: 'SELECT 1' },
        { type: 'text_delta', delta: 'Apple earned ' },
        { type: 'text_delta', delta: '$391.0B' },
      ),
    );

    await sweep();

    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          { kind: 'tool_call', id: 'call_1', sql: 'SELECT 1' },
          { kind: 'text', text: 'Apple earned $391.0B' },
        ],
      }),
    );
  });

  it('does not put back a draft the reader was told to forget', async () => {
    replay.mockResolvedValue(
      seen(
        { type: 'text_delta', delta: 'Apple earned $400B' },
        { type: 'draft_reset', attempt: 2, reason: 'unverifiable_claim' },
        { type: 'text_delta', delta: 'Apple earned $391.0B' },
      ),
    );

    await sweep();

    // The screen was cleared when that draft was discarded. Storing it would put
    // an unverifiable figure into the history as if it had been the answer.
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ parts: [{ kind: 'text', text: 'Apple earned $391.0B' }] }),
    );
  });

  it('is never stored as complete, whatever it had written', async () => {
    replay.mockResolvedValue(seen({ type: 'text_delta', delta: 'Apple earned $391.0B' }));

    await sweep();

    // Nothing checked this answer. `complete` means verified and there is no
    // report to carry, which the database would refuse anyway.
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ verification: null }));
  });
});

describe('a generation that is simply taking a long time', () => {
  it('is left alone as long as it is still producing', async () => {
    // Older than the cutoff and perfectly healthy: a long answer with several
    // tool rounds is minutes of work.
    lastActivityAt.mockResolvedValue(A_MOMENT_AGO);

    expect(await sweep()).toEqual([]);
    expect(finish).not.toHaveBeenCalled();
  });

  it('is judged by its stream rather than by when it started', async () => {
    lastActivityAt.mockResolvedValue(A_MOMENT_AGO);

    await sweep();

    expect(lastActivityAt).toHaveBeenCalledWith(ANSWER.id);
  });

  it('is ended when it has produced nothing at all since it started', async () => {
    // No stream and a row from ten minutes ago: the runner never got as far as
    // its first event, which is what a pod dying at the wrong moment looks like.
    lastActivityAt.mockResolvedValue(null);

    expect(await sweep()).toEqual([ANSWER.id]);
  });
});

describe('a runner that was alive after all', () => {
  it('keeps its own ending, and the sweep says nothing', async () => {
    // It finished between the two reads. The write is conditional on the row
    // still being `generating`, so the loser learns that it lost.
    finish.mockResolvedValue(null);

    expect(await sweep()).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });
});

describe('the budget a dead process was holding', () => {
  it('charges for the text that reached the stream and gives the rest back', async () => {
    finish.mockResolvedValue(STORED);
    replay.mockResolvedValue(seen({ type: 'text_delta', delta: 'Apple earned' }));

    await sweep();

    // What it was charged cannot be read from anywhere: the process never
    // reached the round that reports usage. The text it did produce is real
    // output somebody paid for, and charging nothing for it is the one answer
    // that is certainly wrong.
    expect(budget.priced[0]).toMatchObject({ unreportedText: 'Apple earned', model: '' });
    expect(budget.settled).toHaveLength(1);
    expect(budget.settled[0]?.reservation).toEqual(ANSWER.reservation);
  });

  it('charges nothing when another writer had already ended the generation', async () => {
    finish.mockResolvedValue(null);
    replay.mockResolvedValue(seen({ type: 'text_delta', delta: 'Apple earned' }));

    await sweep();

    expect(budget.settled).toEqual([]);
  });
});
