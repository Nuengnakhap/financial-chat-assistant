import { Writable } from 'node:stream';

import type { AppConfig } from '@fca/config';
import OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming } from 'openai/resources';
import { beforeEach, describe, expect, it } from 'vitest';

import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import {
  llmGatewayContract,
  type GatewayHarness,
  type ProviderScript,
} from '../../application/ports/__tests__/llm-gateway.contract';
import type { CompletionChunk, CompletionRequest } from '../../application/ports/llm-gateway.port';
import { QUERY_TOOL } from '../../application/prompt.factory';
import { OpenAiLlmGateway, type CompletionsApi } from '../openai-llm.gateway';

/**
 * The request this gateway assembles and the chunks it hands back, with the
 * network replaced by a list.
 *
 * What is worth pinning here is everything that fails silently: a missing
 * `stream_options` means no usage is ever reported and a generation's cost
 * becomes a guess; a temperature the model chose means the same question gives
 * different figures; and a capability check that passes when the endpoint
 * ignored the tool would report a system that cannot ground anything as healthy.
 */

const CONFIG = {
  llm: {
    model: 'gpt-5.6-luna',
    apiKey: 'k',
    baseUrl: 'http://localhost',
    maxOutputTokens: 1_500,
    requestTimeoutMs: 60_000,
  },
} as AppConfig;

interface FakeCompletions {
  readonly api: CompletionsApi;
  sent: ChatCompletionCreateParamsStreaming | null;
  chunks: ChatCompletionChunk[];
  failWith: Error | null;
  calls: number;
}

function fakeCompletions(chunks: ChatCompletionChunk[]): FakeCompletions {
  const fake: FakeCompletions = {
    sent: null,
    chunks,
    failWith: null,
    calls: 0,
    api: {
      create: async (body): Promise<AsyncIterable<ChatCompletionChunk>> => {
        fake.calls += 1;
        fake.sent = body;
        if (fake.failWith !== null) throw fake.failWith;
        return await Promise.resolve(
          (async function* stream(): AsyncIterable<ChatCompletionChunk> {
            // One at a time, which is what a stream is.
            // eslint-disable-next-line no-await-in-loop -- see above
            for (const chunk of fake.chunks) yield await Promise.resolve(chunk);
          })(),
        );
      },
    },
  };

  return fake;
}

function delta(content: string): ChatCompletionChunk {
  return {
    id: 'c',
    created: 0,
    model: 'm',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

interface Fragment {
  readonly index: number;
  /** Both come with the first fragment; the rest carry arguments only. */
  readonly id?: string;
  readonly name?: string;
  readonly args: string;
}

function toolCall(fragment: Fragment): ChatCompletionChunk {
  const { index, id, name, args } = fragment;
  return {
    id: 'c',
    created: 0,
    model: 'm',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(id === undefined ? {} : { id }),
              function: { ...(name === undefined ? {} : { name }), arguments: args },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

/** The provider sends this last, in a chunk with no choices in it at all. */
function usage(promptTokens: number, cached: number): ChatCompletionChunk {
  return {
    id: 'c',
    created: 0,
    model: 'm',
    object: 'chat.completion.chunk',
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 20,
      total_tokens: promptTokens + 20,
      prompt_tokens_details: { cached_tokens: cached },
    },
  };
}

function stop(reason: 'stop' | 'tool_calls'): ChatCompletionChunk {
  return {
    id: 'c',
    created: 0,
    model: 'm',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  };
}

const REQUEST: CompletionRequest = {
  messages: [
    { role: 'system', content: 'the rules' },
    { role: 'user', content: 'what was the revenue' },
  ],
  tools: [QUERY_TOOL],
  maxOutputTokens: 900,
};

async function collect(chunks: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const found: CompletionChunk[] = [];
  for await (const chunk of chunks) found.push(chunk);
  return found;
}

/** Captured rather than silenced: what the provider said is the point of it. */
function capturing(): { readonly logger: AppLogger; text: () => string } {
  const written: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  });

  return {
    logger: new AppLogger(createPinoLogger({ level: 'debug', pretty: false, destination })),
    text: () => written.join(''),
  };
}

/**
 * Everything the port promises, asked of the adapter that is actually deployed.
 *
 * The script arrives in words no provider uses and is laid out here the way
 * this one sends it: arguments in fragments identified by position, and the
 * usage report last, in a chunk with no choices in it at all. The same suite
 * runs against a provider that does the opposite, beside the port.
 */
function toOpenAi(script: ProviderScript): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = (script.text ?? []).map(delta);

  for (const [index, call] of (script.calls ?? []).entries()) {
    const [first = '', ...rest] = call.fragments;
    chunks.push(toolCall({ index, id: call.id, name: call.name, args: first }));
    for (const fragment of rest) chunks.push(toolCall({ index, args: fragment }));
  }

  const why = script.finish;
  if (why !== undefined && why !== null) chunks.push(stopping(why));
  // Last, which is where `stream_options.include_usage` puts it.
  const reported = script.usage;
  if (reported !== undefined && reported !== null) chunks.push(reporting(reported));

  return chunks;
}

/** As `stop`, but for the reasons a provider can invent that we do not know. */
function stopping(reason: string): ChatCompletionChunk {
  return {
    id: 'c',
    created: 0,
    model: 'm',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  } as ChatCompletionChunk;
}

function reporting(reported: NonNullable<ProviderScript['usage']>): ChatCompletionChunk {
  return {
    id: 'c',
    created: 0,
    model: reported.model,
    object: 'chat.completion.chunk',
    choices: [],
    usage: {
      prompt_tokens: reported.promptTokens,
      completion_tokens: reported.completionTokens,
      total_tokens: reported.promptTokens + reported.completionTokens,
      prompt_tokens_details: { cached_tokens: reported.cachedPromptTokens },
    },
  };
}

llmGatewayContract('openai protocol', (): GatewayHarness => {
  const silent = capturing().logger;

  return {
    asks: CONFIG.llm.model,
    answering: (script) =>
      new OpenAiLlmGateway(CONFIG, fakeCompletions(toOpenAi(script)).api, silent),
    failing: (error) => {
      const refusing = fakeCompletions([]);
      refusing.failWith = error;

      return new OpenAiLlmGateway(CONFIG, refusing.api, silent);
    },
  };
});

let fake: FakeCompletions;
let logs: ReturnType<typeof capturing>;
let gateway: OpenAiLlmGateway;

beforeEach(() => {
  fake = fakeCompletions([delta('Apple'), delta("'s revenue"), stop('stop')]);
  logs = capturing();
  gateway = new OpenAiLlmGateway(CONFIG, fake.api, logs.logger);
});

describe('the request', () => {
  it('asks for a stream, for usage with it, and for the same answer every time', async () => {
    await collect(gateway.streamCompletion(REQUEST, new AbortController().signal));

    expect(fake.sent).toMatchObject({
      model: 'gpt-5.6-luna',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      max_tokens: 900,
    });
  });

  it('sends the tool the prompt tells the model to call', async () => {
    await collect(gateway.streamCompletion(REQUEST, new AbortController().signal));

    expect(fake.sent?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: QUERY_TOOL.name,
          description: QUERY_TOOL.description,
          parameters: QUERY_TOOL.parameters,
        },
      },
    ]);
  });
});

describe('what comes back', () => {
  it('is text as it arrives, then why it stopped', async () => {
    expect(await collect(gateway.streamCompletion(REQUEST, new AbortController().signal))).toEqual([
      { kind: 'text', text: 'Apple' },
      { kind: 'text', text: "'s revenue" },
      { kind: 'finish', reason: 'stop' },
    ]);
  });

  it('keeps the id when a later fragment repeats it as empty', async () => {
    // Not every endpoint leaves the field out of the continuation fragments.
    // Reading an empty string as the new id would leave the call unaddressable.
    fake.chunks = [
      toolCall({ index: 0, id: 'call_1', name: 'query_financial_data', args: '{"sql":' }),
      toolCall({ index: 0, id: '', name: '', args: '"SELECT 1"}' }),
      stop('tool_calls'),
    ];

    const chunks = await collect(gateway.streamCompletion(REQUEST, new AbortController().signal));

    expect(chunks.find((chunk) => chunk.kind === 'tool_calls')).toMatchObject({
      calls: [{ id: 'call_1', name: 'query_financial_data' }],
    });
  });

  it('is a tool call in one piece, however many fragments it arrived in', async () => {
    fake.chunks = [
      toolCall({ index: 0, id: 'call_1', name: 'query_financial_data', args: '{"sql":"SELECT ' }),
      toolCall({ index: 0, args: 'revenue FROM financial_data"}' }),
      stop('tool_calls'),
    ];

    // The fragments go out as they arrive — a person watching a query being
    // written is watching the assistant work — and the call goes out once more,
    // whole, when the model stops.
    expect(await collect(gateway.streamCompletion(REQUEST, new AbortController().signal))).toEqual([
      { kind: 'tool_call_delta', index: 0, argumentsDelta: '{"sql":"SELECT ' },
      { kind: 'tool_call_delta', index: 0, argumentsDelta: 'revenue FROM financial_data"}' },
      {
        kind: 'tool_calls',
        calls: [
          {
            id: 'call_1',
            name: 'query_financial_data',
            arguments: '{"sql":"SELECT revenue FROM financial_data"}',
          },
        ],
      },
      { kind: 'finish', reason: 'tool_calls' },
    ]);
  });

  it('says nothing about a fragment that carried no arguments', async () => {
    // The first fragment of a call is often just its name and id.
    fake.chunks = [
      toolCall({ index: 0, id: 'call_1', name: 'query_financial_data', args: '' }),
      toolCall({ index: 0, args: '{"sql":"SELECT 1"}' }),
      stop('tool_calls'),
    ];

    const deltas = (
      await collect(gateway.streamCompletion(REQUEST, new AbortController().signal))
    ).filter((chunk) => chunk.kind === 'tool_call_delta');

    expect(deltas).toEqual([
      { kind: 'tool_call_delta', index: 0, argumentsDelta: '{"sql":"SELECT 1"}' },
    ]);
  });
});

describe('what a generation cost', () => {
  it('comes back as its own chunk, cached tokens and all', async () => {
    // Nothing else reports this: the budget is settled from what the provider
    // says it charged, and a streamed call says nothing unless asked.
    fake.chunks = [delta('Apple'), stop('stop'), usage(1_825, 1_536)];

    expect(await collect(gateway.streamCompletion(REQUEST, new AbortController().signal))).toEqual([
      { kind: 'text', text: 'Apple' },
      { kind: 'finish', reason: 'stop' },
      {
        kind: 'usage',
        usage: { promptTokens: 1_825, completionTokens: 20, cachedPromptTokens: 1_536 },
        // The name the provider answered with. A router is asked for `auto` and
        // resolves it per request, so this is the only place the model that has
        // to be paid for is stated.
        model: 'm',
      },
    ]);
  });

  it('reads a provider that does not cache as nothing cached', async () => {
    fake.chunks = [
      stop('stop'),
      {
        id: 'c',
        created: 0,
        model: 'm',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      },
    ];

    const [, reported] = await collect(
      gateway.streamCompletion(REQUEST, new AbortController().signal),
    );

    expect(reported).toEqual({
      kind: 'usage',
      usage: { promptTokens: 100, completionTokens: 5, cachedPromptTokens: 0 },
      model: 'm',
    });
  });

  it('reads the cached prefix an endpoint reports beside the totals', async () => {
    // Measured on the configured endpoint: it reports `cache_read_tokens` and
    // never `prompt_tokens_details`, so reading only the OpenAI spelling prices
    // every cached prefix at full rate for ever, and nothing says so.
    fake.chunks = [
      stop('stop'),
      {
        id: 'c',
        created: 0,
        model: 'gpt-5.6-luna',
        object: 'chat.completion.chunk',
        choices: [],
        usage: Object.assign(
          { prompt_tokens: 1_812, completion_tokens: 5, total_tokens: 1_817 },
          { cache_read_tokens: 1_536 },
        ),
      },
    ];

    const [, reported] = await collect(
      gateway.streamCompletion(REQUEST, new AbortController().signal),
    );

    expect(reported).toEqual({
      kind: 'usage',
      usage: { promptTokens: 1_812, completionTokens: 5, cachedPromptTokens: 1_536 },
      model: 'gpt-5.6-luna',
    });
  });
});

describe('a stream that stops without saying why', () => {
  it('still ends, and still hands over what it collected', async () => {
    // Not every endpoint sends a finish reason. A runner waiting for one would
    // wait for a chunk that is never coming, holding a generation open.
    fake.chunks = [
      delta('thinking'),
      toolCall({
        index: 0,
        id: 'call_1',
        name: 'query_financial_data',
        args: '{"sql":"SELECT 1"}',
      }),
    ];

    expect(await collect(gateway.streamCompletion(REQUEST, new AbortController().signal))).toEqual([
      { kind: 'text', text: 'thinking' },
      { kind: 'tool_call_delta', index: 0, argumentsDelta: '{"sql":"SELECT 1"}' },
      {
        kind: 'tool_calls',
        calls: [{ id: 'call_1', name: 'query_financial_data', arguments: '{"sql":"SELECT 1"}' }],
      },
      { kind: 'finish', reason: 'other' },
    ]);
  });
});

describe('when the endpoint fails', () => {
  it('says what it said, in the log, where an operator is', async () => {
    // The one file that knows there is a provider is the one that says what the
    // provider did. Nothing above this line is told more than "it failed".
    fake.failWith = new Error('connect ECONNREFUSED 10.0.0.1:443');

    await expect(
      collect(gateway.streamCompletion(REQUEST, new AbortController().signal)),
    ).rejects.toThrow('ECONNREFUSED');

    expect(logs.text()).toContain('the model endpoint failed mid-generation');
    expect(logs.text()).toContain('ECONNREFUSED');
  });
});

describe('when somebody presses stop', () => {
  it('is not written down as the endpoint failing', async () => {
    // The breaker already refuses to count this; the log has to agree, or an
    // operator reading it sees an outage every time a person changes their mind.
    fake.failWith = new OpenAI.APIUserAbortError();

    await expect(
      collect(gateway.streamCompletion(REQUEST, new AbortController().signal)),
    ).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);

    expect(logs.text()).toBe('');
  });
});

describe('the capability check', () => {
  it('passes when the endpoint streams and calls the tool', async () => {
    fake.chunks = [
      toolCall({
        index: 0,
        id: 'call_1',
        name: 'query_financial_data',
        args: '{"sql":"SELECT 1"}',
      }),
      stop('tool_calls'),
    ];

    expect(await gateway.checkCapabilities(new AbortController().signal)).toEqual({
      usable: true,
      missing: [],
      // Nothing reported usage, so nothing said which model answered. Empty is
      // the truthful reading of that, and it prices as the dearest there is.
      model: '',
    });
  });

  it('brings back the name the endpoint answered with', async () => {
    // The one moment before a question is asked when a router will say what
    // `auto` means here — and what a question may cost has to be known before
    // it is allowed to start.
    fake.chunks = [
      toolCall({
        index: 0,
        id: 'call_1',
        name: 'query_financial_data',
        args: '{"sql":"SELECT 1"}',
      }),
      stop('tool_calls'),
      usage(20, 0),
    ];

    const found = await gateway.checkCapabilities(new AbortController().signal);

    expect(found.model).toBe('m');
  });

  it('fails when the endpoint answers in words but never calls the tool', async () => {
    // The failure this check exists for: plenty of OpenAI-compatible endpoints
    // hold a conversation perfectly and ignore `tools` entirely, and nothing
    // else notices until the first question comes back ungrounded.
    fake.chunks = [delta('I cannot run queries.'), stop('stop')];

    const found = await gateway.checkCapabilities(new AbortController().signal);

    expect(found.usable).toBe(false);
    expect(found.missing).toEqual(['the endpoint did not call query_financial_data when asked to']);
  });

  it('fails with what the endpoint said rather than a stack', async () => {
    fake.failWith = new Error('connect ECONNREFUSED 127.0.0.1:443');

    expect(await gateway.checkCapabilities(new AbortController().signal)).toEqual({
      usable: false,
      missing: ['connect ECONNREFUSED 127.0.0.1:443'],
      model: '',
    });
  });

  it('says the status and the words when the endpoint refuses', async () => {
    // Measured against the configured endpoint: an unknown model is a 400 with
    // "This model is unavailable on the selected Channel", not the 404 anyone
    // would expect. Only the message says which of the two it is.
    fake.failWith = new OpenAI.APIError(
      400,
      { error: { message: 'This model is unavailable on the selected Channel.' } },
      'This model is unavailable on the selected Channel.',
      undefined,
    );

    const found = await gateway.checkCapabilities(new AbortController().signal);

    // The SDK's message already begins with the status, so nothing is added to
    // it — the sentence is the part that says what to change.
    expect(found.missing[0]).toContain('the endpoint refused the call: 400');
    expect(found.missing[0]).toContain('unavailable on the selected Channel');
  });

  it('does not hold a cancelled call against the endpoint', async () => {
    // Stopping is something this system invites people to do, and the SDK
    // reports it as an error like any other. Counted, five people changing
    // their minds in a row would shut the door on everybody else.
    fake.failWith = new OpenAI.APIUserAbortError();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- ten in a row is the point
      await gateway.checkCapabilities(new AbortController().signal);
    }

    fake.failWith = null;
    fake.chunks = [
      toolCall({
        index: 0,
        id: 'call_1',
        name: 'query_financial_data',
        args: '{"sql":"SELECT 1"}',
      }),
      stop('tool_calls'),
    ];

    expect(await gateway.checkCapabilities(new AbortController().signal)).toEqual({
      usable: true,
      missing: [],
      // Nothing reported usage, so nothing said which model answered. Empty is
      // the truthful reading of that, and it prices as the dearest there is.
      model: '',
    });
  });

  it('brings back the name the endpoint answered with', async () => {
    // The one moment before a question is asked when a router will say what
    // `auto` means here — and what a question may cost has to be known before
    // it is allowed to start.
    fake.chunks = [
      toolCall({
        index: 0,
        id: 'call_1',
        name: 'query_financial_data',
        args: '{"sql":"SELECT 1"}',
      }),
      stop('tool_calls'),
      usage(20, 0),
    ];

    const found = await gateway.checkCapabilities(new AbortController().signal);

    expect(found.model).toBe('m');
  });

  it('stops asking an endpoint that keeps failing', async () => {
    fake.failWith = new Error('down');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- consecutive failures is the point
      await gateway.checkCapabilities(new AbortController().signal);
    }
    const callsBefore = fake.calls;

    const found = await gateway.checkCapabilities(new AbortController().signal);

    // The circuit is open: no sixth call was made, and the reason says so
    // rather than repeating the endpoint's error.
    expect(fake.calls).toBe(callsBefore);
    expect(found.missing[0]).toContain('circuit is open');
  });
});
