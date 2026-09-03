import type { Coverage } from '@fca/grounding';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../agent-events';
import { AgentRunner, type GenerationRequest } from '../agent-runner';
import type { GenerationContext, GenerationContextFactory } from '../generation-context';
import type { AgentTool } from '../ports/agent-tool.port';
import type {
  ChatMessage,
  CompletionChunk,
  CompletionRequest,
  LlmGateway,
} from '../ports/llm-gateway.port';
import type { QueryOutcome } from '../ports/tool-outcome';
import { QUERY_TOOL } from '../prompt.factory';

/**
 * Every branch of a generation, with a model that is a list.
 *
 * What is worth pinning here is not that the happy path works — it is what
 * happens on the paths nobody watches: a figure with nothing behind it, a model
 * that keeps querying and never answers, a person pressing stop, an endpoint
 * that goes away mid-sentence. Each of those has a different right answer and
 * only one of them ends with an answer on screen.
 */

const COVERAGE: Coverage = {
  years: [2023, 2024],
  columns: new Map([
    ['company', 'plain'],
    ['year', 'plain'],
    ['revenue', 'money'],
  ]),
};

const CONTEXT: GenerationContext = {
  systemPrompt: 'the rules',
  coverage: COVERAGE,
  maxOutputTokens: 900,
  model: 'a-model',
  fingerprint: 'abc',
};

const APPLE: QueryOutcome = {
  toolCallId: 'call_1',
  sql: "SELECT company, revenue FROM financial_data WHERE company = 'Apple' LIMIT 50",
  columns: ['company', 'revenue'],
  rows: [['Apple', '391035000000']],
  display: new Map([['revenue', ['$391.0B']]]),
  rowCount: 1,
  truncated: null,
  elapsedMs: 3,
  fromCache: false,
  failure: null,
};

/** A turn the model spends writing, in the small pieces a real one arrives in. */
function says(text: string): readonly CompletionChunk[] {
  const chunks: CompletionChunk[] = [];
  for (let at = 0; at < text.length; at += 3) {
    chunks.push({ kind: 'text', text: text.slice(at, at + 3) });
  }

  return [...chunks, { kind: 'finish', reason: 'stop' }];
}

/** What a provider reports about a call it has finished, always last. */
function costs(promptTokens: number, cached = 0): CompletionChunk {
  return {
    kind: 'usage',
    usage: { promptTokens, completionTokens: 40, cachedPromptTokens: cached },
    // The name the provider answered with, which is what the round is charged
    // to — not the name it was asked for.
    model: 'gpt-5.6-luna',
  };
}

function asks(sql: string, id = 'call_1'): readonly CompletionChunk[] {
  return [
    { kind: 'tool_call_delta', index: 0, argumentsDelta: JSON.stringify({ sql }) },
    {
      kind: 'tool_calls',
      calls: [{ id, name: 'query_financial_data', arguments: JSON.stringify({ sql }) }],
    },
    { kind: 'finish', reason: 'tool_calls' },
  ];
}

interface FakeGateway {
  readonly gateway: LlmGateway;
  turns: (readonly CompletionChunk[])[];
  failWith: Error | null;
  requests: number;
  /** Every request as it was sent, which is where the pairing rule is visible. */
  sent: CompletionRequest[];
  aborted: number;
}

function fakeGateway(...turns: (readonly CompletionChunk[])[]): FakeGateway {
  const fake: FakeGateway = {
    turns,
    failWith: null,
    requests: 0,
    sent: [],
    aborted: 0,
    gateway: {
      checkCapabilities: async () =>
        await Promise.resolve({ usable: true, missing: [], model: 'gpt-5.6-luna' }),
      streamCompletion: (request, signal): AsyncIterable<CompletionChunk> => {
        const chunks = fake.turns[fake.requests] ?? [];
        fake.requests += 1;
        fake.sent.push(request);
        // The real client aborts the request the moment the signal fires,
        // whether or not anybody asks it for another chunk — which is the
        // difference between stopping a stream and merely walking away from it.
        signal.addEventListener('abort', () => (fake.aborted += 1), { once: true });

        return (async function* stream(): AsyncIterable<CompletionChunk> {
          if (fake.failWith !== null) throw fake.failWith;
          // Deliberately indifferent to the signal: a response that has already
          // arrived is a list in memory, and a library aborting the request it
          // came from does not un-send it. Stopping has to be the runner's job.
          for (const chunk of chunks) {
            // One at a time, which is what a stream is.
            // eslint-disable-next-line no-await-in-loop -- see above
            yield await Promise.resolve(chunk);
          }
        })();
      },
    },
  };

  return fake;
}

interface FakeTool {
  readonly tool: AgentTool;
  outcomes: QueryOutcome[];
  asked: string[];
}

/**
 * A tool named the way the fake model names it, since the runner now dispatches
 * by name. The arguments arrive as the JSON the model wrote, and reading `sql`
 * out of them is this tool's business rather than the runner's.
 */
function fakeTool(...outcomes: QueryOutcome[]): FakeTool {
  const fake: FakeTool = {
    outcomes: outcomes.length > 0 ? outcomes : [APPLE],
    asked: [],
    tool: {
      definition: QUERY_TOOL,
      execute: async (toolCallId, argumentsJson): Promise<QueryOutcome> => {
        fake.asked.push(sqlIn(argumentsJson));
        const outcome = fake.outcomes[Math.min(fake.asked.length - 1, fake.outcomes.length - 1)];
        return await Promise.resolve({ ...(outcome ?? APPLE), toolCallId });
      },
    },
  };

  return fake;
}

function sqlIn(argumentsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    const sql =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'sql') : undefined;

    return typeof sql === 'string' ? sql : '';
  } catch {
    return '';
  }
}

function runnerWith(
  gateway: FakeGateway,
  tool: FakeTool,
  context: GenerationContext | null = CONTEXT,
): AgentRunner {
  const contexts = { current: () => context } as unknown as GenerationContextFactory;
  return new AgentRunner(gateway.gateway, [tool.tool], contexts);
}

const QUESTION: GenerationRequest = { question: "Apple's revenue?", history: [] };

/** Everything, including the opening event that `collect` drops. */
async function collectAll(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const found: AgentEvent[] = [];
  for await (const event of events) found.push(event);
  return found;
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const found: AgentEvent[] = [];
  for await (const event of events) found.push(event);
  // Dropped from what the assertions read: every generation that gets as far as
  // the model opens with it, and one test below is about that on its own.
  return found.filter((event) => event.type !== 'generation_started');
}

function textOf(events: readonly AgentEvent[]): string {
  return events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('');
}

function typesOf(events: readonly AgentEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

/** Tool messages with no assistant call before them: the shape a provider rejects. */
function unanswered(messages: readonly ChatMessage[]): readonly string[] {
  const called = new Set<string>();
  const orphaned: string[] = [];

  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls) called.add(call.id);
    if (message.role === 'tool' && !called.has(message.toolCallId))
      orphaned.push(message.toolCallId);
  }

  return orphaned;
}

/** Runs of the same event type as one, since how text is chunked is the gate's. */
function collapse(types: readonly string[]): readonly string[] {
  return types.filter((type, index) => type !== types[index - 1]);
}

let signal: AbortSignal;

beforeEach(() => {
  signal = new AbortController().signal;
});

describe('a question that is answered', () => {
  it('queries, answers, and says the answer was checked', async () => {
    const gateway = fakeGateway(
      asks("SELECT company, revenue FROM financial_data WHERE company = 'Apple'"),
      says("Apple's revenue was $391.0B."),
    );
    const tool = fakeTool();

    const events = await collect(runnerWith(gateway, tool).run(QUESTION, signal));

    // Deltas are counted as one: the gate releases text in whatever sized
    // pieces it can clear, which is its business and not this test's.
    expect(collapse(typesOf(events))).toEqual([
      'tool_call_delta',
      'tool_call_ready',
      'tool_result',
      'text_delta',
      'verification',
      'finished',
    ]);
    expect(textOf(events)).toBe("Apple's revenue was $391.0B.");
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'answered' });
  });

  it('shows the query that ran, not the one the model typed', async () => {
    // The tool hands back the canonical form; that is what was executed and
    // what a person is shown.
    const gateway = fakeGateway(asks('select company,revenue from financial_data'), says('Done.'));
    const tool = fakeTool();

    const events = await collect(runnerWith(gateway, tool).run(QUESTION, signal));

    expect(events.find((event) => event.type === 'tool_call_ready')).toEqual({
      type: 'tool_call_ready',
      id: 'call_1',
      sql: APPLE.sql,
    });
  });

  it('passes on what the answer cost, cached tokens and all', async () => {
    const gateway = fakeGateway(
      [...asks('SELECT revenue FROM financial_data'), costs(1_800)],
      [...says('It was $391.0B.'), costs(1_900, 1_536)],
    );

    const events = await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    // One per round: what a generation costs is the sum of its rounds, and the
    // runner does not add up money — it reports what it was told.
    expect(events.filter((event) => event.type === 'usage')).toEqual([
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
        outputTokens: 40,
        cachedInputTokens: 1_536,
        model: 'gpt-5.6-luna',
      },
    ]);
  });

  it('carries a verification report with the figures it checked', async () => {
    const gateway = fakeGateway(
      asks('SELECT revenue FROM financial_data'),
      says('It was $391.0B.'),
    );

    const events = await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));
    const verification = events.find((event) => event.type === 'verification');

    expect(verification).toMatchObject({ report: { verdict: 'pass' } });
    expect(verification?.type === 'verification' && verification.report.checkedClaims.length).toBe(
      1,
    );
  });
});

describe('a figure with nothing behind it', () => {
  it('never reaches the reader, and the draft is written again', async () => {
    const gateway = fakeGateway(
      asks('SELECT revenue FROM financial_data'),
      says("Apple's revenue was $999.9B."),
      says("Apple's revenue was $391.0B."),
    );

    const events = await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    // The invented figure is nowhere in what was emitted — not even for an
    // instant, because the gate held it back rather than correcting it after.
    expect(textOf(events)).not.toContain('999');
    expect(events.filter((event) => event.type === 'draft_reset')).toEqual([
      { type: 'draft_reset', attempt: 2, reason: 'unverifiable_claim' },
    ]);
    expect(events.at(-1)).toMatchObject({ outcome: 'answered' });
  });

  it('stops the model mid-sentence rather than paying for the rest', async () => {
    const gateway = fakeGateway(
      asks('SELECT revenue FROM financial_data'),
      says("Apple's revenue was $999.9B and it went on at some length."),
      says('It was $391.0B.'),
    );

    await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    expect(gateway.aborted).toBeGreaterThan(0);
  });

  it('gives up after three drafts and answers from the rows instead', async () => {
    const invented = says('It was $999.9B.');
    const gateway = fakeGateway(
      asks('SELECT company, revenue FROM financial_data'),
      invented,
      invented,
      invented,
    );

    const events = await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    expect(events.filter((event) => event.type === 'draft_reset').length).toBe(2);
    expect(events.at(-1)).toMatchObject({ outcome: 'answered_with_fallback' });
    // The fallback is the rows, so the figure it does carry is one of theirs.
    expect(textOf(events)).toContain('391');
  });
});

describe('a refusal with no query behind it', () => {
  it('never leaves the server, and ends in the rows', async () => {
    // Saying the dataset lacks something is itself a claim about the dataset.
    // The gate stops this one as it streams — it knows nothing was queried — so
    // it is refused exactly like an invented figure, rather than talked about.
    const groundless = says('This dataset does not have that.');
    const gateway = fakeGateway(groundless, groundless, groundless);

    const events = await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    expect(textOf(events)).not.toContain('does not have');
    expect(events.filter((event) => event.type === 'draft_reset').length).toBe(2);
    expect(events.at(-1)).toMatchObject({ outcome: 'answered_with_fallback' });
  });
});

describe('a draft that only the verifier can refuse', () => {
  const TWO_YEARS: QueryOutcome = {
    ...APPLE,
    rows: [
      ['Apple', '391035000000'],
      ['Apple', '383285000000'],
    ],
    rowCount: 2,
  };

  /** Both figures are real; the chart draws one the sentence never mentions. */
  const disagreeing = says(
    'It was $391.0B.\n\n```chart\n{"type":"bar","xKey":"year","data":[{"revenue":383285000000}]}\n```',
  );

  it('is repaired, and after three drafts answered from the rows', async () => {
    // The gate cannot catch this one: read a figure at a time, every figure is
    // supported. It is only wrong as a whole answer, which is what the verifier
    // reads — and the one path where a draft is refused after it was written.
    const gateway = fakeGateway(
      asks('SELECT company, revenue FROM financial_data'),
      disagreeing,
      disagreeing,
      disagreeing,
    );

    const events = await collect(runnerWith(gateway, fakeTool(TWO_YEARS)).run(QUESTION, signal));
    const verdicts = events
      .filter((event) => event.type === 'verification')
      .map((event) => event.report.verdict);

    // Three drafts read and refused, then the rows — and the last report is the
    // fallback's own, because nothing is sent without having been checked.
    expect(verdicts).toEqual(['fail', 'fail', 'fail', 'pass']);
    expect(events.filter((event) => event.type === 'draft_reset').length).toBe(2);
    expect(events.at(-1)).toMatchObject({ outcome: 'answered_with_fallback' });
  });
});

describe('a model that will not answer', () => {
  it('is cut off after five rounds and the rows are sent instead', async () => {
    const query = asks('SELECT revenue FROM financial_data');
    const gateway = fakeGateway(query, query, query, query, query, query, query);

    const events = await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    expect(gateway.requests).toBe(5);
    expect(events.at(-1)).toMatchObject({ outcome: 'answered_with_fallback' });
  });
});

describe('stopping', () => {
  it('keeps what was written and settles', async () => {
    const controller = new AbortController();
    const gateway = fakeGateway(
      says('Apple earned a great deal in the year you asked about, and here is the rest of it.'),
    );
    const runner = runnerWith(gateway, fakeTool());

    // Stopped as soon as there is something on screen, which is when a person
    // would reach for the button.
    const events: AgentEvent[] = [];
    for await (const event of runner.run(QUESTION, controller.signal)) {
      events.push(event);
      if (event.type === 'text_delta' && !controller.signal.aborted) controller.abort();
    }

    const finished = events.at(-1);
    // Stopped even though the stream itself would happily have carried on:
    // the runner asks, rather than waiting to be told by the client library.
    expect(finished).toMatchObject({ type: 'finished', outcome: 'stopped' });
    expect(gateway.aborted).toBeGreaterThan(0);
    // What the reader saw is kept: it was all checked before it was sent.
    expect(finished?.type === 'finished' && finished.text).toBe(textOf(events));
    expect(finished?.type === 'finished' && finished.report).toBeNull();
  });
});

describe('stopping before anything arrives', () => {
  it('is a stop, not a failure', async () => {
    // The abort lands while the request is still in flight, so the client throws
    // rather than the runner noticing between chunks. Both roads end in a stop.
    const controller = new AbortController();
    controller.abort();
    const gateway = fakeGateway(says('never sent'));
    gateway.failWith = new Error('The request was aborted.');

    const events = await collect(runnerWith(gateway, fakeTool()).run(QUESTION, controller.signal));

    expect(events).toEqual([{ type: 'finished', outcome: 'stopped', text: '', report: null }]);
  });
});

describe('when something is wrong with the machinery', () => {
  it('says so in words a person can read, and carries nothing from the machine', async () => {
    const gateway = fakeGateway(says('never sent'));
    gateway.failWith = new Error('connect ECONNREFUSED 10.0.0.1:443');

    const events = await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    expect(events).toEqual([
      {
        type: 'error',
        code: 'generation_failed',
        message: 'Something went wrong while writing the answer. Please try asking again.',
      },
      { type: 'finished', outcome: 'failed', text: '', report: null },
    ]);
    // Not an address, not a syscall, not the name of a library. Whoever asked a
    // question about revenue is owed a sentence, and the rest belongs in a log.
    expect(JSON.stringify(events)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(events)).not.toContain('10.0.0.1');
  });

  it('refuses to start at all without knowing what the dataset holds', async () => {
    // Without the catalog the model would be told nothing about coverage and
    // would answer from memory, which is the one thing this system prevents.
    const contexts = { current: () => null } as unknown as GenerationContextFactory;
    const runner = new AgentRunner(fakeGateway().gateway, [fakeTool().tool], contexts);

    const events = await collect(runner.run(QUESTION, signal));

    expect(events).toEqual([
      {
        type: 'error',
        code: 'unavailable',
        message: 'The assistant cannot answer questions right now. Please try again shortly.',
      },
    ]);
  });
});

describe('the transcript the model is sent back', () => {
  it('carries its own tool call, then the answer to it', async () => {
    // The provider's rule, and the one that turns a working round into a 400:
    // an assistant turn holding tool calls has to be followed by one `tool`
    // message per call. It is invisible from outside until the second request.
    const gateway = fakeGateway(
      asks('SELECT revenue FROM financial_data'),
      says('It was $391.0B.'),
    );

    await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    const second = gateway.sent[1]?.messages ?? [];
    expect(second.at(-2)).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'call_1', name: 'query_financial_data' }],
    });
    expect(second.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
  });

  it('never leaves an answer without the call it answers', async () => {
    const gateway = fakeGateway(
      asks('SELECT revenue FROM financial_data'),
      asks('SELECT net_income FROM financial_data', 'call_2'),
      says('It was $391.0B.'),
    );

    await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    for (const request of gateway.sent) expect(unanswered(request.messages)).toEqual([]);
  });

  it('says what was wrong at the end, without disturbing what came before', async () => {
    const gateway = fakeGateway(
      asks('SELECT revenue FROM financial_data'),
      says('It was $999.9B.'),
      says('It was $391.0B.'),
    );

    await collect(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    const [second, third] = [gateway.sent[1]?.messages ?? [], gateway.sent[2]?.messages ?? []];
    // The repair is appended: everything the second request said is still said,
    // in the same order, so the provider's cache of the prefix survives.
    expect(third.slice(0, second.length)).toEqual(second);
    expect(third.at(-1)).toMatchObject({ role: 'system' });
  });
});

describe('what the model is told', () => {
  it('hears about a query it wrote that could not run', async () => {
    const refused: QueryOutcome = {
      ...APPLE,
      sql: null,
      columns: [],
      rows: [],
      display: new Map(),
      rowCount: 0,
      failure: { kind: 'table', message: 'Only financial_data can be queried.' },
    };
    const gateway = fakeGateway(
      asks('SELECT * FROM users'),
      says('This dataset does not have that.'),
    );

    const events = await collect(runnerWith(gateway, fakeTool(refused)).run(QUESTION, signal));

    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      error: 'Only financial_data can be queried.',
      rowCount: 0,
    });
    // A refusal after a query that ran is an answer, not a violation.
    expect(events.at(-1)).toMatchObject({ outcome: 'answered' });
  });

  it('shows what the model asked for when there was nothing to run', async () => {
    // Neither a canonical form nor readable arguments: what is left to show is
    // the text the model wrote, which is what a person needs to see.
    const refused: QueryOutcome = { ...APPLE, sql: null, columns: [], rows: [], rowCount: 0 };
    const gateway = fakeGateway(
      [
        {
          kind: 'tool_calls',
          calls: [{ id: 'call_1', name: 'query_financial_data', arguments: '{"nothing":"here"}' }],
        },
        { kind: 'finish', reason: 'tool_calls' },
      ],
      says('This dataset does not have that.'),
    );

    const events = await collect(runnerWith(gateway, fakeTool(refused)).run(QUESTION, signal));

    expect(events.find((event) => event.type === 'tool_call_ready')).toMatchObject({
      sql: '{"nothing":"here"}',
    });
  });

  it('gets an answer even to a call that was never a query', async () => {
    // A call with unreadable arguments still needs a `tool` message, or the next
    // request is malformed and the whole generation dies on a round that worked.
    const gateway = fakeGateway(
      [
        {
          kind: 'tool_calls',
          calls: [{ id: 'call_1', name: 'query_financial_data', arguments: 'not json' }],
        },
        { kind: 'finish', reason: 'tool_calls' },
      ],
      says('This dataset does not have that.'),
    );
    const tool = fakeTool();

    await collect(runnerWith(gateway, tool).run(QUESTION, signal));

    expect(tool.asked).toEqual(['']);
  });
});

describe('the first thing a generation says', () => {
  it('is which model is about to be asked', async () => {
    const gateway = fakeGateway(says('Nothing to see.'));

    const [first] = await collectAll(runnerWith(gateway, fakeTool()).run(QUESTION, signal));

    // Not read from configuration where it is streamed: the model named here is
    // the one this generation was actually built for, and it is also what gets
    // stored on the row.
    expect(first).toEqual({ type: 'generation_started', model: CONTEXT.model });
  });

  it('is not said at all when there is nothing to ask it with', async () => {
    const gateway = fakeGateway(says('unreachable'));

    const events = await collectAll(runnerWith(gateway, fakeTool(), null).run(QUESTION, signal));

    // A generation that never starts must not announce that it did — a client
    // would clear the composer and wait for a stream that is already over.
    expect(events.map((event) => event.type)).toEqual(['error']);
  });
});

/**
 * The runner sends whatever tools it was given and dispatches on the name the
 * model came back with. It has no idea what any of them do, which is the whole
 * of what `AgentTool` bought — a third tool is a provider and a class, and
 * nothing in this file changes.
 */
describe('more than one tool', () => {
  const second: AgentTool = {
    definition: {
      name: 'describe_coverage',
      description: 'what the dataset covers',
      parameters: { type: 'object', properties: {} },
    },
    execute: async (toolCallId) =>
      await Promise.resolve({ ...APPLE, toolCallId, sql: 'SELECT count(*) FROM financial_data' }),
  };

  function runnerOver(gateway: FakeGateway, tools: readonly AgentTool[]): AgentRunner {
    const contexts = { current: () => CONTEXT } as unknown as GenerationContextFactory;
    return new AgentRunner(gateway.gateway, tools, contexts);
  }

  it('offers the model every one of them, in the order they were bound', async () => {
    const first = fakeTool();
    const gateway = fakeGateway(says('Apple earned $383.3B.'));

    await collect(runnerOver(gateway, [first.tool, second]).run(QUESTION, signal));

    expect(gateway.sent[0]?.tools.map((tool) => tool.name)).toEqual([
      'query_financial_data',
      'describe_coverage',
    ]);
  });

  it('sends a call to the tool the model named, and to no other', async () => {
    const first = fakeTool();
    const gateway = fakeGateway(
      [
        {
          kind: 'tool_calls',
          calls: [{ id: 'call_1', name: 'describe_coverage', arguments: '{}' }],
        },
        { kind: 'finish', reason: 'tool_calls' },
      ],
      says('Apple earned $383.3B.'),
    );

    const events = await collect(runnerOver(gateway, [first.tool, second]).run(QUESTION, signal));

    expect(first.asked).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_call_ready',
        sql: 'SELECT count(*) FROM financial_data',
      }),
    );
  });

  it('tells the model when it asks for a tool that does not exist', async () => {
    // The alternative is a generation that ends on a name the model made up.
    // It picked from a list; being told which names are on it is something it
    // can act on, and the next round usually does.
    const first = fakeTool();
    const gateway = fakeGateway(
      [
        {
          kind: 'tool_calls',
          calls: [{ id: 'call_1', name: 'read_the_news', arguments: '{}' }],
        },
        { kind: 'finish', reason: 'tool_calls' },
      ],
      says('Apple earned $383.3B.'),
    );

    const events = await collect(runnerOver(gateway, [first.tool, second]).run(QUESTION, signal));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        error:
          'There is no tool called read_the_news. The tools available are: query_financial_data, describe_coverage.',
      }),
    );
    // And the generation carried on to answer, rather than ending there.
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'answered' });
  });
});
