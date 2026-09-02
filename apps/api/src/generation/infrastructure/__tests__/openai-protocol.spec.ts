import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../application/ports/llm-gateway.port';
import { toMessages, toTools } from '../openai-protocol';

/**
 * The translation both ways, on its own.
 *
 * A transcript is the part of this that a provider is strictest about: an
 * assistant message carrying tool calls has to be followed by one `tool` message
 * per call, with the ids matching, or the endpoint answers 400 and the whole
 * generation dies on a round that had already done its work. So the shape is
 * pinned here rather than discovered later.
 */

describe('a transcript', () => {
  it('carries all four roles', () => {
    const messages: readonly ChatMessage[] = [
      { role: 'system', content: 'the rules' },
      { role: 'user', content: 'what was the revenue' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call_1', name: 'query_financial_data', arguments: '{"sql":"SELECT 1"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"rows":[["1"]]}' },
    ];

    expect(toMessages(messages)).toEqual([
      { role: 'system', content: 'the rules' },
      { role: 'user', content: 'what was the revenue' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'query_financial_data', arguments: '{"sql":"SELECT 1"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"rows":[["1"]]}' },
    ]);
  });

  it('leaves out an empty list of tool calls rather than sending one', () => {
    // Some endpoints reject `tool_calls: []` where they accept the field being
    // absent, and an assistant turn that only said something has no calls.
    const [message] = toMessages([{ role: 'assistant', content: 'Apple.', toolCalls: [] }]);

    expect(message).toEqual({ role: 'assistant', content: 'Apple.' });
    expect(message && 'tool_calls' in message).toBe(false);
  });

  it('keeps every call of a turn that made two', () => {
    const [message] = toMessages([
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call_1', name: 'query_financial_data', arguments: '{"sql":"SELECT 1"}' },
          { id: 'call_2', name: 'query_financial_data', arguments: '{"sql":"SELECT 2"}' },
        ],
      },
    ]);

    expect(message).toMatchObject({ tool_calls: [{ id: 'call_1' }, { id: 'call_2' }] });
  });
});

describe('a tool definition', () => {
  it('goes across as a function with its schema', () => {
    expect(
      toTools([{ name: 'q', description: 'runs a query', parameters: { type: 'object' } }]),
    ).toEqual([
      {
        type: 'function',
        function: { name: 'q', description: 'runs a query', parameters: { type: 'object' } },
      },
    ]);
  });

  it.each([
    ['a string', 'not a schema'],
    ['a list', ['not', 'a', 'schema']],
    ['nothing', null],
  ])('describes a tool whose schema is %s as taking nothing', (_case, parameters) => {
    // Better to say the tool takes nothing than to say something untrue about
    // what it takes; the policy refuses whatever comes back either way.
    expect(toTools([{ name: 'q', description: 'd', parameters }])).toEqual([
      { type: 'function', function: { name: 'q', description: 'd', parameters: {} } },
    ]);
  });
});
