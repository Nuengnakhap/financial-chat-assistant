import { describe, expect, it } from 'vitest';

import type { QueryOutcome } from '../ports/tool-outcome';
import { QUERY_TOOL } from '../prompt.factory';
import { Transcript, type PastTurn } from '../transcript';

/**
 * The rules a provider is strictest about, and the one rule the verifier is
 * strictest about — kept in one place because they are about the same rounds.
 */

const OUTCOME: QueryOutcome = {
  toolCallId: 'call_1',
  sql: 'SELECT revenue FROM financial_data LIMIT 50',
  columns: ['revenue'],
  rows: [['391035000000']],
  display: new Map([['revenue', ['$391.0B']]]),
  rowCount: 1,
  truncated: null,
  elapsedMs: 2,
  fromCache: false,
  failure: null,
};

const request = (transcript: Transcript) => transcript.toRequest([QUERY_TOOL], 900);

describe('what the model is sent', () => {
  it('opens with the rules and ends with the question', () => {
    const transcript = new Transcript('the rules', [], 'what was the revenue');

    expect(request(transcript).messages).toEqual([
      { role: 'system', content: 'the rules' },
      { role: 'user', content: 'what was the revenue' },
    ]);
  });

  it('replays earlier turns, oldest first', () => {
    const history: readonly PastTurn[] = [
      { role: 'user', text: 'and before that?' },
      { role: 'assistant', text: 'It was lower.' },
    ];

    expect(request(new Transcript('the rules', history, 'now?')).messages).toEqual([
      { role: 'system', content: 'the rules' },
      { role: 'user', content: 'and before that?' },
      { role: 'assistant', content: 'It was lower.', toolCalls: [] },
      { role: 'user', content: 'now?' },
    ]);
  });

  it('keeps the last twenty turns and drops the older ones', () => {
    const history: readonly PastTurn[] = Array.from({ length: 30 }, (_unused, index) => ({
      role: 'user' as const,
      text: `turn ${String(index)}`,
    }));

    const messages = request(new Transcript('the rules', history, 'now?')).messages;

    expect(messages.length).toBe(22);
    expect(messages[1]).toEqual({ role: 'user', content: 'turn 10' });
    // The system message is never one of the ones dropped: it is the prefix a
    // provider's cache is keyed on, and the rules the answer is written under.
    expect(messages[0]).toEqual({ role: 'system', content: 'the rules' });
  });

  it('pairs an assistant turn with an answer to every call it made', () => {
    // The rule the provider answers 400 for, and the easiest one to break by
    // accident, since trimming history is exactly the code that halves a pair.
    const transcript = new Transcript('the rules', [], 'what was the revenue');
    transcript.appendAssistantTurn('', [
      { id: 'call_1', name: 'query_financial_data', arguments: '{"sql":"SELECT revenue"}' },
    ]);
    transcript.appendToolResult(OUTCOME);

    const [, , assistant, tool] = request(transcript).messages;
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_1' }],
    });
    expect(tool).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    expect(tool?.role === 'tool' && tool.content).toContain('391035000000');
  });

  it('appends a repair instruction rather than rewriting what was said', () => {
    // Editing an earlier message would change the prefix, and with it every
    // cached token the provider was going to give back.
    const transcript = new Transcript('the rules', [], 'what was the revenue');
    // With a round already behind it, since that is when a repair happens: the
    // rounds that led here have to survive, or the model is asked to fix an
    // answer it can no longer see.
    transcript.appendAssistantTurn('', [
      { id: 'call_1', name: 'query_financial_data', arguments: '{"sql":"SELECT revenue"}' },
    ]);
    transcript.appendToolResult(OUTCOME);
    const before = request(transcript).messages;
    transcript.appendRepairInstruction('The figure $999.9B is not in any result.');

    const after = request(transcript).messages;
    expect(before.length).toBe(4);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toEqual({
      role: 'system',
      content: 'The figure $999.9B is not in any result.',
    });
  });
});

describe('what the verifier is given', () => {
  it('is what this generation asked for, in order', () => {
    const transcript = new Transcript('the rules', [], 'what was the revenue');
    transcript.appendAssistantTurn('', []);
    transcript.appendToolResult(OUTCOME);
    transcript.appendToolResult({ ...OUTCOME, toolCallId: 'call_2' });

    expect(transcript.toolResults().map((result) => result.toolCallId)).toEqual([
      'call_1',
      'call_2',
    ]);
  });

  it('is empty when nothing has been asked, however long the history', () => {
    // The difference between a refusal resting on an empty result and one
    // resting on the model's reading of the prompt — which the verifier refuses.
    const history: readonly PastTurn[] = [
      { role: 'user', text: "Apple's revenue?" },
      { role: 'assistant', text: 'It was $391.0B.' },
    ];

    expect(new Transcript('the rules', history, 'and Microsoft?').toolResults()).toEqual([]);
  });

  it('does not replay an old answer as though it were evidence', () => {
    // A figure from a previous exchange has nothing supporting it here, and the
    // model has to ask again rather than repeat itself. The cost is a query;
    // the alternative is trusting a number because we said it once.
    const history: readonly PastTurn[] = [{ role: 'assistant', text: 'It was $391.0B.' }];
    const transcript = new Transcript('the rules', history, 'and the year before?');

    const [, assistant] = request(transcript).messages;
    expect(assistant).toEqual({ role: 'assistant', content: 'It was $391.0B.', toolCalls: [] });
    expect(transcript.toolResults()).toEqual([]);
  });
});
