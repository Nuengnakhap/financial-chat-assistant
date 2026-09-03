import type { AppConfig } from '@fca/config';
import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming } from 'openai/resources';

import { toChunks, toMessages, toTools } from './openai-protocol';
import { CircuitBreaker } from '../../shared/async/circuit-breaker';
import { APP_CONFIG } from '../../shared/config/app-config.token';
import { AppLogger, asError } from '../../shared/observability/app-logger';
import type {
  Capabilities,
  ChatMessage,
  CompletionChunk,
  CompletionRequest,
  LlmGateway,
} from '../application/ports/llm-gateway.port';
import { QUERY_TOOL } from '../application/prompt.factory';

/**
 * The only file that knows this provider exists.
 *
 * Retries are the SDK's — it knows which of its own statuses are worth
 * repeating, and reads `retry-after` when one comes back. Layering another retry
 * on top would multiply, not add: two of ours around two of theirs is four calls
 * to an endpoint that has already said no twice. What the SDK has no opinion
 * about is the fifth failure in a row, so that is the one thing added here.
 *
 * Only the connection is retried, never the stream. Once tokens have arrived,
 * asking again would produce a second answer to a question that is already half
 * answered, and the caller has no way to unsay the first half.
 */

/**
 * The one call this gateway makes, as an interface rather than as the client
 * that implements it. The SDK type stays on this side of the line — the module
 * binds the factory below — and a test can hand over a stream of chunks without
 * a network, which is the only way the assembly of a request is checkable at
 * all.
 */
export interface CompletionsApi {
  create(
    body: ChatCompletionCreateParamsStreaming,
    options: { readonly signal: AbortSignal },
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
}

export const OPENAI_COMPLETIONS = Symbol('OpenAiCompletions');

export function createOpenAiCompletions(config: AppConfig): CompletionsApi {
  return new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseUrl,
    // The SDK's own retry: it knows which of its statuses are worth repeating
    // and reads `retry-after`. Ours would multiply with it rather than add.
    maxRetries: CONNECT_ATTEMPTS,
    timeout: config.llm.requestTimeoutMs,
  }).chat.completions;
}

const CONNECT_ATTEMPTS = 2;
const FAILURES_BEFORE_OPENING = 5;
const CIRCUIT_OPEN_MS = 15_000;
/** Enough for a sentence and a tool call, which is all the smoke call needs. */
const CAPABILITY_MAX_TOKENS = 64;

@Injectable()
export class OpenAiLlmGateway implements LlmGateway {
  private readonly model: string;
  private readonly breaker = new CircuitBreaker({
    failuresBeforeOpening: FAILURES_BEFORE_OPENING,
    openForMs: CIRCUIT_OPEN_MS,
    countsAsFailure: saysSomethingAboutTheEndpoint,
  });

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(OPENAI_COMPLETIONS) private readonly completions: CompletionsApi,
    private readonly logger: AppLogger,
  ) {
    this.model = config.llm.model;
  }

  async *streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<CompletionChunk> {
    // Said here and nowhere else. What went wrong is a fact about this provider —
    // a refused key, a closed circuit, a socket that would not open — and this is
    // the one file that knows there is a provider. Everything above is told only
    // that the answer could not be written, because that is all a reader can use.
    try {
      yield* this.attempt(request, signal);
    } catch (error) {
      // The same question the breaker asks, asked by the same function: a log
      // full of "the endpoint failed" every time somebody presses stop would
      // describe an outage that never happened.
      if (saysSomethingAboutTheEndpoint(error)) {
        this.logger.warn('the model endpoint failed mid-generation', {
          scope: 'OpenAiLlmGateway',
          err: asError(error),
        });
      }
      throw error;
    }
  }

  private async *attempt(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<CompletionChunk> {
    const stream = await this.breaker.run(
      async () =>
        await this.completions.create(
          {
            model: this.model,
            messages: toMessages(request.messages),
            tools: toTools(request.tools),
            stream: true,
            // Without this the provider reports nothing at all about a streamed
            // call, and what a generation cost would have to be guessed at.
            stream_options: { include_usage: true },
            // The same question twice should reach the same figures.
            temperature: 0,
            max_tokens: request.maxOutputTokens,
          },
          { signal },
        ),
    );

    yield* toChunks(stream);
  }

  /**
   * Does this endpoint stream, and will it call a tool? Both are load-bearing —
   * an endpoint that answers ordinary chat perfectly but ignores `tools` cannot
   * ground a single figure — and both are cheap to find out.
   */
  async checkCapabilities(signal: AbortSignal): Promise<Capabilities> {
    try {
      return await this.smokeCall(signal);
    } catch (error) {
      return { usable: false, missing: [describe(error)], model: '' };
    }
  }

  private async smokeCall(signal: AbortSignal): Promise<Capabilities> {
    const messages: readonly ChatMessage[] = [
      {
        role: 'user',
        content: `Call ${QUERY_TOOL.name} with the SQL: SELECT company FROM financial_data LIMIT 1`,
      },
    ];

    const chunks: CompletionChunk[] = [];
    for await (const chunk of this.streamCompletion(
      { messages, tools: [QUERY_TOOL], maxOutputTokens: CAPABILITY_MAX_TOKENS },
      signal,
    )) {
      chunks.push(chunk);
    }

    const missing: string[] = [];
    if (chunks.length === 0) missing.push('the endpoint returned no streamed chunks');
    if (!chunks.some((chunk) => chunk.kind === 'tool_calls')) {
      missing.push(`the endpoint did not call ${QUERY_TOOL.name} when asked to`);
    }

    return { usable: missing.length === 0, missing, model: modelIn(chunks) };
  }
}

/**
 * Whether an error says anything about the endpoint at all.
 *
 * Somebody pressing stop does not: counted as a failure, five people changing
 * their minds in a row would open the circuit on everyone else, and a log of
 * them would read as an outage. Stopping is a thing this system invites people
 * to do, so it is not evidence of anything except that they did it.
 *
 * One definition, asked in both places, so the breaker and the log can never
 * come to disagree about what a failure is.
 */
function saysSomethingAboutTheEndpoint(error: unknown): boolean {
  return !(error instanceof OpenAI.APIUserAbortError);
}

/**
 * What went wrong, in words for whoever has to fix the configuration.
 *
 * The SDK's own message is the useful part and it already begins with the
 * status, so nothing is added to it: measured against the configured endpoint,
 * an unknown model comes back as `400 This model is unavailable on the selected
 * Channel` — not the 404 anyone would expect, and only the sentence says which
 * of the two it is.
 */
function describe(error: unknown): string {
  if (error instanceof OpenAI.APIError) return `the endpoint refused the call: ${error.message}`;
  return error instanceof Error ? error.message : 'the endpoint could not be reached';
}

/**
 * What the endpoint answered as. Worth one line here because it is the only
 * place the name is knowable before a question is asked — and what a question
 * may cost has to be known before it is allowed to start.
 */
function modelIn(chunks: readonly CompletionChunk[]): string {
  const reported = chunks.find((chunk) => chunk.kind === 'usage');

  return reported?.model ?? '';
}
