import type { GroundingReport, MessageView, StreamEvent } from '@fca/contracts';
import { ConversationId, MessageId, MicroUsd, ReservationId, UserId } from '@fca/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent-events';
import type { AgentRunner } from '../agent-runner';
import { AnswerBooks } from '../answer-books';
import type { GenerationEvents } from '../ports/generation-events.port';
import type { Answer, FinishedAnswer, GenerationMessages } from '../ports/generation-messages.port';
import { RunGenerationUseCase } from '../run-generation.use-case';
import { budgetDouble, type BudgetDouble } from './budget-double';

/**
 * What a generation leaves behind: a stream a client can read from either end,
 * and a row that says how it ended. The runner itself is replaced here — what it
 * decides has its own spec next door — so that these are only about the two
 * writes and the one rule tying them together, which is that an assistant
 * message is `complete` exactly when a report came with it.
 */

const ANSWER: Answer = {
  id: MessageId.trusted('a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d'),
  conversationId: ConversationId.trusted('cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21'),
  ownerId: UserId.trusted('e5c9f4a1-1f0e-4a6a-9d4e-0c8b6a3f21d0'),
  seq: 2,
  status: 'generating',
  startedAt: new Date('2026-09-02T10:00:00.000Z'),
  // A claim on the asker's budget, which every ending has to give back.
  reservation: {
    userId: UserId.trusted('e5c9f4a1-1f0e-4a6a-9d4e-0c8b6a3f21d0'),
    id: ReservationId.trusted('2f1c2a1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b'),
    windowStart: new Date('2026-09-02T10:00:00.000Z'),
  },
};

const REPORT: GroundingReport = {
  verdict: 'pass',
  checkedClaims: [
    {
      text: '$391.0B',
      value: '391035000000',
      toolCallId: 'call_1',
      rowIndex: 0,
      column: 'revenue',
    },
  ],
  violations: [],
};

const STORED: MessageView = {
  id: ANSWER.id,
  conversationId: ANSWER.conversationId,
  seq: ANSWER.seq,
  role: 'assistant',
  status: 'complete',
  parts: [{ kind: 'text', text: "Apple's revenue was $391.0B." }],
  verification: REPORT,
  usage: null,
  error: null,
  createdAt: ANSWER.startedAt.toISOString(),
};

const questionFor = vi.fn();
const finish = vi.fn<(answer: FinishedAnswer) => Promise<MessageView | null>>();
const append = vi.fn<(messageId: MessageId, event: StreamEvent) => Promise<void>>();

const messages = { questionFor, finish } as unknown as GenerationMessages;
const events = { append } as unknown as GenerationEvents;

let produced: AgentEvent[];

const runner = {
  run: async function* run(): AsyncGenerator<AgentEvent> {
    // eslint-disable-next-line no-await-in-loop -- one at a time, which is what a stream is.
    for (const event of produced) yield await Promise.resolve(event);
  },
} as unknown as AgentRunner;

const run = () =>
  new RunGenerationUseCase(runner, new AnswerBooks(messages, budget), events).execute(
    ANSWER,
    new AbortController().signal,
  );

const streamed = (): readonly StreamEvent[] => append.mock.calls.map(([, event]) => event);
const written = (): FinishedAnswer | undefined => finish.mock.calls[0]?.[0];

let budget: BudgetDouble;

beforeEach(() => {
  budget = budgetDouble();
  vi.resetAllMocks();
  questionFor.mockResolvedValue({ text: "Apple's revenue?", history: [] });
  finish.mockResolvedValue(STORED);
  produced = [];
});

describe('an answer that was checked', () => {
  beforeEach(() => {
    produced = [
      { type: 'generation_started', model: 'a-model' },
      { type: 'tool_call_ready', id: 'call_1', sql: 'SELECT 1' },
      {
        type: 'tool_result',
        toolCallId: 'call_1',
        rowCount: 1,
        preview: [{ revenue: '391035000000' }],
        elapsedMs: 4,
        error: null,
      },
      { type: 'text_delta', delta: "Apple's revenue was $391.0B." },
      { type: 'verification', report: REPORT },
      {
        type: 'usage',
        inputTokens: 1_800,
        outputTokens: 90,
        cachedInputTokens: 1_500,
        model: 'gpt-5.6-luna',
      },
      {
        type: 'finished',
        outcome: 'answered',
        text: "Apple's revenue was $391.0B.",
        report: REPORT,
      },
    ];
  });

  it('puts everything a client can read on the stream, and nothing it cannot', async () => {
    await run();

    // The runner's own `usage` events stop here — a client is told once, at the
    // end, with a price on it — and `finished` never leaves at all: it is this
    // process telling itself the loop is over, and what a client reads instead
    // is the message that was stored because of it.
    expect(streamed().map((event) => event.type)).toEqual([
      'generation_started',
      'tool_call_ready',
      'tool_result',
      'text_delta',
      'verification',
      'usage',
      'message_complete',
    ]);
  });

  it('names the message the client asked about in the opening event', async () => {
    await run();

    expect(streamed()[0]).toEqual({
      type: 'generation_started',
      assistantMessageId: ANSWER.id,
      model: 'a-model',
    });
  });

  it('stores the verified text, the queries behind it, and the report', async () => {
    await run();

    expect(written()).toEqual({
      messageId: ANSWER.id,
      status: 'complete',
      parts: [
        { kind: 'tool_call', id: 'call_1', sql: 'SELECT 1' },
        {
          kind: 'tool_result',
          toolCallId: 'call_1',
          rowCount: 1,
          preview: [{ revenue: '391035000000' }],
          elapsedMs: 4,
          error: null,
        },
        // The text as it was verified, not as it was chunked: an answer
        // assembled from deltas would carry the discarded drafts too.
        { kind: 'text', text: "Apple's revenue was $391.0B." },
      ],
      verification: REPORT,
      model: 'gpt-5.6-luna',
      inputTokens: 1_800,
      cachedInputTokens: 1_500,
      outputTokens: 90,
      cost: MicroUsd.fromMicro(1_890n),
      // The ledger entry that has to be written with the row rather than after
      // it: an answer stored without its charge is one somebody got for free.
      charge: { userId: ANSWER.ownerId, windowStart: ANSWER.reservation?.windowStart },
    });
  });

  it('adds up what every round cost, not just the last one', async () => {
    // One `usage` arrives per round, and an ordinary question takes at least
    // two — query, then answer. Keeping only the last would silently drop the
    // round that carried the whole prompt prefix.
    produced = [
      { type: 'generation_started', model: 'a-model' },
      {
        type: 'usage',
        inputTokens: 1_800,
        outputTokens: 40,
        cachedInputTokens: 0,
        model: 'gpt-5.6-luna',
      },
      {
        type: 'usage',
        inputTokens: 1_900,
        outputTokens: 90,
        cachedInputTokens: 1_536,
        model: 'gpt-5.6-luna',
      },
      {
        type: 'finished',
        outcome: 'answered',
        text: "Apple's revenue was $391.0B.",
        report: REPORT,
      },
    ];

    await run();

    // Each round is billed for the whole prompt it sent, prefix included, so
    // the sum is the charge rather than a double-count.
    expect(written()).toMatchObject({ inputTokens: 3_700, outputTokens: 130 });
  });

  it('ends the stream with the message it actually stored', async () => {
    await run();

    // Not a message built here from the same parts: what a client renders has to
    // be the row, or a reload would show it something else.
    expect(streamed().at(-1)).toEqual({ type: 'message_complete', message: STORED });
  });

  it('says nothing about a completion it did not write', async () => {
    // A stop or a janitor got to the row first and has already put a terminal
    // event on the stream. A second one would contradict it.
    finish.mockResolvedValue(null);

    await run();

    expect(streamed().map((event) => event.type)).not.toContain('message_complete');
  });

  it('charges the budget only after the row says this process ended it', async () => {
    await run();

    expect(budget.settled).toEqual([
      { reservation: ANSWER.reservation, cost: MicroUsd.fromMicro(1_890n) },
    ]);
  });

  it('charges nothing when another writer ended the generation first', async () => {
    // The counter would then hold this process's figure while the row and the
    // ledger hold somebody else's, and a window rebuilt from the ledger would
    // disagree with the counter it was rebuilding.
    finish.mockResolvedValue(null);

    await run();

    expect(budget.settled).toEqual([]);
  });

  it('reports what was spent, and what is left, before the stream ends', async () => {
    await run();

    const spent = streamed().at(-2);
    expect(spent).toEqual({
      type: 'usage',
      inputTokens: 1_800,
      outputTokens: 90,
      costMicroUsd: '1890',
      budget: {
        spentMicroUsd: '1000',
        reservedMicroUsd: '0',
        limitMicroUsd: '1000000',
        resetAt: '2026-09-02T15:00:00.000Z',
        exceeded: false,
      },
    });
  });

  it('prices what the provider reported and asks for nothing to be counted', async () => {
    await run();

    // Every round reported, so there is nothing left to estimate — counting the
    // final text again would charge for it twice.
    expect(budget.priced).toEqual([
      {
        model: 'gpt-5.6-luna',
        inputTokens: 1_800,
        cachedInputTokens: 1_500,
        outputTokens: 90,
        unreportedText: '',
        estimatedInputTokens: 1_800,
      },
    ]);
  });
});

describe('a generation that was stopped', () => {
  it('keeps what had been written and stores it as stopped, with no report', async () => {
    produced = [
      { type: 'generation_started', model: 'a-model' },
      { type: 'text_delta', delta: 'Apple' },
      { type: 'finished', outcome: 'stopped', text: 'Apple', report: null },
    ];

    await run();

    expect(written()?.status).toBe('stopped');
    expect(written()?.parts).toEqual([{ kind: 'text', text: 'Apple' }]);
    expect(written()?.verification).toBeNull();
  });

  it('charges for the round the provider never reported', async () => {
    // Stopping abandons a response the provider had already begun sending, so
    // its usage never arrives. Charging nothing for it would make the stop
    // button a way of reading an answer for free.
    produced = [
      { type: 'generation_started', model: 'a-model' },
      {
        type: 'usage',
        inputTokens: 1_800,
        outputTokens: 40,
        cachedInputTokens: 0,
        model: 'gpt-5.6-luna',
      },
      { type: 'text_delta', delta: 'Apple earned' },
      { type: 'finished', outcome: 'stopped', text: 'Apple earned', report: null },
    ];

    await run();

    expect(budget.priced[0]).toMatchObject({
      unreportedText: 'Apple earned',
      // The round before it is the closest bound on what the cut-off round sent,
      // since the transcript only ever grows.
      estimatedInputTokens: 1_800,
    });
    expect(budget.settled).toHaveLength(1);
  });
});

describe('a generation that failed', () => {
  beforeEach(() => {
    produced = [
      { type: 'generation_started', model: 'a-model' },
      { type: 'error', code: 'generation_failed', message: 'Something went wrong.' },
      { type: 'finished', outcome: 'failed', text: '', report: null },
    ];
  });

  it('stores it as an error and lets the failure be the end of the stream', async () => {
    await run();

    expect(written()?.status).toBe('error');
    // `error` is already terminal, so a `message_complete` after it would be an
    // event no client is still reading for.
    expect(streamed().map((event) => event.type)).toEqual(['generation_started', 'error']);
  });
});

describe('an answer that finished without ever being checked', () => {
  it('is stored as an error, because a complete one without a report cannot exist', async () => {
    // The database says so too — `chk_complete_has_verification` — and this is
    // the code deciding the same thing rather than finding out from a rejection.
    produced = [
      { type: 'generation_started', model: 'a-model' },
      { type: 'text_delta', delta: 'trust me' },
      { type: 'finished', outcome: 'answered', text: 'trust me', report: null },
    ];

    await run();

    expect(written()?.status).toBe('error');
    expect(written()?.verification).toBeNull();
  });
});

describe('a placeholder with no question in front of it', () => {
  beforeEach(() => {
    questionFor.mockResolvedValue(null);
    produced = [{ type: 'generation_started', model: 'a-model' }];
  });

  it('ends without asking the model anything', async () => {
    await run();

    // Left `generating`, it would block the conversation for good and the
    // janitor would keep finding it.
    expect(written()?.status).toBe('error');
    expect(streamed().map((event) => event.type)).toEqual(['error']);
  });

  it('says nothing on a stream whose generation somebody else had already ended', async () => {
    // A stop or a janitor got there first and has put its own terminal event on
    // the stream. The row decides, and the loser stays quiet — the same rule the
    // ordinary ending follows.
    finish.mockResolvedValue(null);

    await run();

    expect(streamed()).toEqual([]);
  });
});
