import { describe, expect, it } from 'vitest';

import { QUERY_TOOL } from '../../prompt.factory';
import type { CompletionChunk, CompletionRequest, LlmGateway } from '../llm-gateway.port';

/**
 * One set of questions, asked of every adapter behind `LlmGateway`.
 *
 * The port exists so that nothing above it knows a provider's protocol, which
 * means the guarantees are all about translation: fragments of a tool call
 * arriving by position and leaving whole, a usage report naming the model that
 * *answered* rather than the one that was asked for, and a stream that stops
 * without saying why still ending somewhere. Every one of those is something a
 * second provider would spell differently, and every one of them fails
 * silently — a gateway that loses the cached-token count does not crash, it
 * bills a cached prefix at full rate for ever.
 *
 * The script below is written in words no provider uses. Each adapter's spec
 * translates it into its own wire shape, which is the only way this suite can
 * be a contract rather than a description of whichever one was written first.
 */

interface ScriptedCall {
  readonly id: string;
  readonly name: string;
  /** Split however the provider splits it — one piece or twenty. */
  readonly fragments: readonly string[];
}

interface ScriptedUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  /** What the provider says answered, which a router may resolve to anything. */
  readonly model: string;
}

export interface ProviderScript {
  readonly text?: readonly string[];
  readonly calls?: readonly ScriptedCall[];
  readonly usage?: ScriptedUsage | null;
  /** The provider's own spelling, or null for a stream that just ends. */
  readonly finish?: string | null;
}

export interface GatewayHarness {
  /** A gateway wired to a provider that will answer with exactly this. */
  answering(script: ProviderScript): LlmGateway;
  /** A gateway wired to a provider that will not answer at all. */
  failing(error: Error): LlmGateway;
  /** The model this gateway was configured to ask for. */
  readonly asks: string;
}

const ASK: CompletionRequest = {
  messages: [{ role: 'user', content: 'what did Apple earn in 2023?' }],
  tools: [QUERY_TOOL],
  maxOutputTokens: 256,
};

async function collect(gateway: LlmGateway): Promise<readonly CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const chunk of gateway.streamCompletion(ASK, new AbortController().signal)) {
    chunks.push(chunk);
  }

  return chunks;
}

const only = <T extends CompletionChunk['kind']>(
  chunks: readonly CompletionChunk[],
  kind: T,
): readonly Extract<CompletionChunk, { kind: T }>[] =>
  chunks.filter((chunk): chunk is Extract<CompletionChunk, { kind: T }> => chunk.kind === kind);

export function llmGatewayContract(name: string, harness: () => GatewayHarness): void {
  describe(`LlmGateway contract: ${name}`, () => {
    it('hands words on in the order they were written', async () => {
      const gateway = harness().answering({ text: ['Apple', ' earned'], finish: 'stop' });

      expect(only(await collect(gateway), 'text').map((chunk) => chunk.text)).toEqual([
        'Apple',
        ' earned',
      ]);
    });

    it('shows a query being written, then hands it over once and whole', async () => {
      // Both halves matter. Nothing can run a quarter of a query, so only the
      // whole one is worth acting on — and a person watching a query appear is
      // watching the assistant work rather than watching a spinner.
      const gateway = harness().answering({
        calls: [{ id: 'call_1', name: QUERY_TOOL.name, fragments: ['{"sql":"SELE', 'CT 1"}'] }],
        finish: 'tool_calls',
      });

      const chunks = await collect(gateway);
      const deltas = only(chunks, 'tool_call_delta');
      const [whole] = only(chunks, 'tool_calls');

      expect(deltas.map((chunk) => chunk.argumentsDelta).join('')).toBe('{"sql":"SELECT 1"}');
      expect(whole?.calls).toEqual([
        { id: 'call_1', name: QUERY_TOOL.name, arguments: '{"sql":"SELECT 1"}' },
      ]);
    });

    it('keeps two queries asked for at once apart', async () => {
      const gateway = harness().answering({
        calls: [
          { id: 'call_1', name: QUERY_TOOL.name, fragments: ['{"sql":"A"}'] },
          { id: 'call_2', name: QUERY_TOOL.name, fragments: ['{"sql":"B"}'] },
        ],
        finish: 'tool_calls',
      });

      const [whole] = only(await collect(gateway), 'tool_calls');

      expect(whole?.calls.map((call) => call.arguments)).toEqual(['{"sql":"A"}', '{"sql":"B"}']);
      expect(whole?.calls.map((call) => call.id)).toEqual(['call_1', 'call_2']);
    });

    it('hands the calls over before it says the turn is finished', async () => {
      // The runner acts on `tool_calls` and stops reading at `finish`. The other
      // order loses the query entirely.
      const gateway = harness().answering({
        calls: [{ id: 'call_1', name: QUERY_TOOL.name, fragments: ['{}'] }],
        finish: 'tool_calls',
      });

      const chunks = await collect(gateway);
      const kinds = chunks.map((chunk) => chunk.kind);

      expect(kinds.indexOf('tool_calls')).toBeGreaterThanOrEqual(0);
      expect(kinds.indexOf('tool_calls')).toBeLessThan(kinds.indexOf('finish'));
      // And the reason survives the translation. Without this, an adapter that
      // answered `other` to everything would pass the whole suite.
      expect(only(chunks, 'finish')[0]?.reason).toBe('tool_calls');
    });

    it('reports the model that answered, not the one that was asked for', async () => {
      // A router takes `auto` and picks. Charging for what was asked for prices
      // every answer at the wrong model, and nothing anywhere goes red.
      const it = harness();
      const gateway = it.answering({
        text: ['x'],
        finish: 'stop',
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          cachedPromptTokens: 0,
          model: 'resolved-by-the-router',
        },
      });

      const [usage] = only(await collect(gateway), 'usage');

      expect(usage?.model).toBe('resolved-by-the-router');
      expect(usage?.model).not.toBe(it.asks);
    });

    it('carries what the provider served from its own cache', async () => {
      const gateway = harness().answering({
        text: ['x'],
        finish: 'stop',
        usage: {
          promptTokens: 3_960,
          completionTokens: 200,
          cachedPromptTokens: 1_536,
          model: 'm',
        },
      });

      const [usage] = only(await collect(gateway), 'usage');

      expect(usage?.usage).toEqual({
        promptTokens: 3_960,
        completionTokens: 200,
        cachedPromptTokens: 1_536,
      });
    });

    it('says a turn is over exactly once, and why', async () => {
      const gateway = harness().answering({ text: ['x'], finish: 'stop' });

      expect(only(await collect(gateway), 'finish')).toEqual([{ kind: 'finish', reason: 'stop' }]);
    });

    it('tells a turn cut short apart from one that ended', async () => {
      // `length` is the reason the runner would need to say the answer was cut
      // off rather than finished, so folding it into `stop` loses the one thing
      // that distinguishes a complete answer from half of one.
      const gateway = harness().answering({ text: ['half a sen'], finish: 'length' });

      expect(only(await collect(gateway), 'finish')[0]?.reason).toBe('length');
    });

    it('ends a stream that stopped without saying why', async () => {
      // Otherwise a caller waiting for a reason waits for a chunk that is never
      // coming, and the generation hangs until a janitor finds it.
      const gateway = harness().answering({ text: ['half a sen'], finish: null });

      expect(only(await collect(gateway), 'finish')).toEqual([{ kind: 'finish', reason: 'other' }]);
    });

    it('folds a reason it has never heard of into "other"', async () => {
      const gateway = harness().answering({ text: ['x'], finish: 'content_filter' });

      expect(only(await collect(gateway), 'finish')[0]?.reason).toBe('other');
    });

    it('finds an endpoint that streams and calls a tool usable', async () => {
      const gateway = harness().answering({
        calls: [{ id: 'c', name: QUERY_TOOL.name, fragments: ['{"sql":"SELECT 1"}'] }],
        finish: 'tool_calls',
        usage: { promptTokens: 10, completionTokens: 1, cachedPromptTokens: 0, model: 'luna' },
      });

      await expect(gateway.checkCapabilities(new AbortController().signal)).resolves.toEqual({
        usable: true,
        missing: [],
        model: 'luna',
      });
    });

    it('finds an endpoint that answers but ignores tools unusable, and says so', async () => {
      // The worst kind of healthy: perfectly good chat, and not one figure it
      // can ground.
      const gateway = harness().answering({ text: ['about ninety billion'], finish: 'stop' });

      const capabilities = await gateway.checkCapabilities(new AbortController().signal);

      expect(capabilities.usable).toBe(false);
      expect(capabilities.missing.join(' ')).toContain(QUERY_TOOL.name);
    });

    it('finds an endpoint that says nothing at all unusable', async () => {
      const gateway = harness().answering({ finish: null });

      await expect(gateway.checkCapabilities(new AbortController().signal)).resolves.toMatchObject({
        usable: false,
      });
    });

    it('answers rather than throwing when the endpoint refuses', async () => {
      // This runs at boot. An exception here stops the process instead of
      // printing the sentence that says what to fix.
      const gateway = harness().failing(new Error('401 incorrect api key provided'));

      const capabilities = await gateway.checkCapabilities(new AbortController().signal);

      expect(capabilities.usable).toBe(false);
      expect(capabilities.missing.join(' ')).toContain('401');
      expect(capabilities.model).toBe('');
    });
  });
}
