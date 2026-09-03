import { expect } from 'vitest';

import type { LlmGateway } from '../llm-gateway.port';
import {
  llmGatewayContract,
  type GatewayHarness,
  type ProviderScript,
} from './llm-gateway.contract';
import { TerseLlmGateway, type TerseEvent, type TerseProvider } from './terse-llm.gateway';

/**
 * The contract against the adapter that exists to disagree with the other one.
 * The same suite runs against `OpenAiLlmGateway` in its own spec; between them,
 * no sentence in the contract can be a property of one provider's protocol.
 */

const ASKS_FOR = 'terse-default';

/** The script, laid out the way this provider would send it: cost first. */
function toTerse(script: ProviderScript): TerseEvent[] {
  const events: TerseEvent[] = [];

  if (script.usage !== undefined && script.usage !== null) {
    events.push({
      t: 'meta',
      model: script.usage.model,
      prompt: script.usage.promptTokens,
      completion: script.usage.completionTokens,
      cached: script.usage.cachedPromptTokens,
    });
  }

  for (const said of script.text ?? []) events.push({ t: 'say', s: said });
  // Whole in one event: this provider does not fragment arguments at all.
  for (const call of script.calls ?? []) {
    events.push({ t: 'call', id: call.id, fn: call.name, args: call.fragments.join('') });
  }

  const finish = script.finish;
  if (finish !== undefined && finish !== null) events.push({ t: 'end', why: spell(finish) });

  return events;
}

/** Its own words, so the adapter has to map rather than pass through. */
function spell(reason: string): string {
  return { stop: 'end_turn', tool_calls: 'wants_tool', length: 'too_long' }[reason] ?? reason;
}

function provider(events: readonly TerseEvent[]): TerseProvider {
  return {
    open: async (asked) => {
      // The model asked for reaches the provider; what comes back says what
      // actually answered, which is the whole point of the case that checks it.
      expect(asked.model).toBe(ASKS_FOR);

      return await Promise.resolve(
        (async function* stream(): AsyncIterable<TerseEvent> {
          // eslint-disable-next-line no-await-in-loop -- a stream yields in order or it is not a stream
          for (const event of events) yield await Promise.resolve(event);
        })(),
      );
    },
  };
}

const harness = (): GatewayHarness => ({
  asks: ASKS_FOR,
  answering: (script: ProviderScript): LlmGateway =>
    new TerseLlmGateway(provider(toTerse(script)), ASKS_FOR),
  failing: (error: Error): LlmGateway =>
    new TerseLlmGateway(
      {
        open: async () => await Promise.reject(error),
      },
      ASKS_FOR,
    ),
});

llmGatewayContract('a provider that says everything differently', harness);
