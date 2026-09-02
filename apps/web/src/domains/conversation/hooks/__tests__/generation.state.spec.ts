import type { GroundingReport, MessagePart, StreamEvent } from '@fca/contracts';
import { describe, expect, it } from 'vitest';

import {
  IDLE,
  generatingId,
  isBusy,
  reduce,
  type GenerationAction,
  type GenerationState,
} from '../generation.state';

/**
 * Every transition, including the ones that must not happen. A stream is where
 * an older tab meets a newer server, so the rule this file exists to hold is
 * that nothing in it can throw: an event that makes no sense here leaves the
 * state exactly as it was.
 */

const ANSWER = 'a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d';

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

const frame = (event: StreamEvent, id: string | null = '1-0'): GenerationAction => ({
  type: 'frame',
  frame: { id, event },
});

const text = (delta: string): StreamEvent => ({ type: 'text_delta', delta });

const RESULT: StreamEvent = {
  type: 'tool_result',
  toolCallId: 'call_1',
  rowCount: 1,
  preview: [{ revenue: '391035000000' }],
  elapsedMs: 4,
  error: null,
};

/** Runs a whole exchange, the way the hook feeds one in. */
function run(...actions: GenerationAction[]): GenerationState {
  return actions.reduce(reduce, IDLE);
}

const watching = (): GenerationAction[] => [
  { type: 'ask', question: "Apple's revenue?" },
  { type: 'watch', assistantMessageId: ANSWER },
];

const partsOf = (state: GenerationState): readonly MessagePart[] =>
  state.phase === 'streaming' || state.phase === 'reconnecting' ? state.view.parts : [];

describe('asking a question', () => {
  it('shows it before the server has said anything', () => {
    const state = run({ type: 'ask', question: "Apple's revenue?" });

    // The question is on screen while the command is still in flight: a person
    // who pressed send and saw nothing would press it again.
    expect(state).toEqual({ phase: 'starting', question: "Apple's revenue?" });
    expect(isBusy(state)).toBe(true);
    expect(generatingId(state)).toBeNull();
  });

  it('has nothing to stop until there is an answer being written', () => {
    expect(generatingId(run(...watching()))).toBe(ANSWER);
  });
});

describe('text arriving in pieces', () => {
  it('joins them into one part rather than one part each', () => {
    const state = run(...watching(), frame(text('Apple earned ')), frame(text('$391.0B')));

    // Forty deltas would otherwise be forty blocks with a gap between each.
    expect(partsOf(state)).toEqual([{ kind: 'text', text: 'Apple earned $391.0B' }]);
  });

  it('starts a new part when a tool call came between', () => {
    const state = run(
      ...watching(),
      frame(text('Looking. ')),
      frame({ type: 'tool_call_ready', id: 'call_1', sql: 'SELECT 1' }),
      frame(text('Apple earned $391.0B')),
    );

    expect(partsOf(state).map((part) => part.kind)).toEqual(['text', 'tool_call', 'text']);
  });
});

describe('a query being written', () => {
  it('grows as the model types it', () => {
    const state = run(
      ...watching(),
      frame({ type: 'tool_call_delta', index: 0, argsDelta: '{"sql":"SELECT' }),
      frame({ type: 'tool_call_delta', index: 0, argsDelta: ' revenue"}' }),
    );

    expect(state.phase === 'streaming' && state.view.writingSql).toBe('{"sql":"SELECT revenue"}');
  });

  it('is cleared by the call that is actually going to run', () => {
    const state = run(
      ...watching(),
      frame({ type: 'tool_call_delta', index: 0, argsDelta: '{"sql":"SEL' }),
      frame({ type: 'tool_call_ready', id: 'call_1', sql: 'SELECT revenue FROM financial_data' }),
    );

    // What runs is the canonical statement the server answered with, not the
    // half-typed JSON it grew out of.
    expect(state.phase === 'streaming' && state.view.writingSql).toBe('');
    expect(partsOf(state)).toEqual([
      { kind: 'tool_call', id: 'call_1', sql: 'SELECT revenue FROM financial_data' },
    ]);
  });

  it('keeps its result beside it, in the order it happened', () => {
    const state = run(
      ...watching(),
      frame({ type: 'tool_call_ready', id: 'call_1', sql: 'SELECT 1' }),
      frame(RESULT),
    );

    expect(partsOf(state)).toEqual([
      { kind: 'tool_call', id: 'call_1', sql: 'SELECT 1' },
      {
        kind: 'tool_result',
        toolCallId: 'call_1',
        rowCount: 1,
        preview: [{ revenue: '391035000000' }],
        elapsedMs: 4,
        error: null,
      },
    ]);
  });
});

describe('a draft being written again', () => {
  it('drops the text and keeps the queries behind it', () => {
    const state = run(
      ...watching(),
      frame({ type: 'tool_call_ready', id: 'call_1', sql: 'SELECT 1' }),
      frame(RESULT),
      frame(text('Apple earned $400B')),
      frame({ type: 'draft_reset', attempt: 2, reason: 'unverifiable_claim' }),
    );

    // What was released had already been checked, so discarding it is safe. The
    // cards stay because the data did not change — only what was said about it.
    expect(partsOf(state).map((part) => part.kind)).toEqual(['tool_call', 'tool_result']);
    expect(state.phase === 'streaming' && state.view.recheckAttempt).toBe(2);
  });

  it('clears the last verdict, which belonged to the draft that went', () => {
    const state = run(
      ...watching(),
      frame({ type: 'verification', report: REPORT }),
      frame({ type: 'draft_reset', attempt: 2, reason: 'unverifiable_claim' }),
    );

    expect(state.phase === 'streaming' && state.view.verification).toBeNull();
  });
});

describe('where the client has got to', () => {
  it('moves with every event that has a position', () => {
    const state = run(...watching(), frame(text('one'), '5-0'), frame(text(' two'), '9-2'));

    expect(state.phase === 'streaming' && state.lastEventId).toBe('9-2');
  });

  it('stays where it was for an event the server made up', () => {
    // `reconnect_hint` has no position in the stream. Taking one from it would
    // resume from somewhere that does not exist.
    const state = run(
      ...watching(),
      frame(text('one'), '5-0'),
      frame({ type: 'reconnect_hint' }, null),
    );

    expect(state.phase === 'streaming' && state.lastEventId).toBe('5-0');
  });
});

describe('losing the connection', () => {
  it('keeps everything on screen and says it is coming back', () => {
    const state = run(...watching(), frame(text('Apple earned ')), { type: 'dropped', attempt: 2 });

    expect(state.phase).toBe('reconnecting');
    // The answer is still being written on the server. Clearing what is already
    // there would make a reconnect look like a restart.
    expect(partsOf(state)).toEqual([{ kind: 'text', text: 'Apple earned ' }]);
    expect(state.phase === 'reconnecting' && state.attempt).toBe(2);
  });

  it('carries on from where it was when the connection comes back', () => {
    const state = run(
      ...watching(),
      frame(text('Apple earned '), '5-0'),
      { type: 'dropped', attempt: 1 },
      { type: 'resumed' },
      frame(text('$391.0B'), '6-0'),
    );

    expect(partsOf(state)).toEqual([{ kind: 'text', text: 'Apple earned $391.0B' }]);
    expect(state.phase === 'streaming' && state.lastEventId).toBe('6-0');
  });

  it('keeps what it has when the same generation is watched again', () => {
    // What a resume does: attach to the same message, with the view intact.
    const state = run(...watching(), frame(text('Apple earned ')), {
      type: 'watch',
      assistantMessageId: ANSWER,
    });

    expect(partsOf(state)).toEqual([{ kind: 'text', text: 'Apple earned ' }]);
  });

  it('starts clean when a different generation is watched', () => {
    const state = run(...watching(), frame(text('Apple earned ')), {
      type: 'watch',
      assistantMessageId: 'b2e1d4c3-5c6f-4b7a-8d9e-1f2a3b4c5d6e',
    });

    expect(partsOf(state)).toEqual([]);
  });
});

describe('an event that makes no sense here', () => {
  it('leaves the state alone rather than throwing', () => {
    // A frame with nothing being watched: a stop that raced the last event, or
    // a stream that outlived the page it belonged to.
    expect(reduce(IDLE, frame(text('lost')))).toBe(IDLE);
    expect(reduce(IDLE, { type: 'dropped', attempt: 1 })).toBe(IDLE);
    expect(reduce(IDLE, { type: 'resumed' })).toBe(IDLE);
  });

  it('ignores an event it has nothing to draw for', () => {
    const before = run(...watching());
    const after = reduce(
      before,
      frame({ type: 'generation_started', assistantMessageId: ANSWER, model: 'a-model' }),
    );

    expect(after.phase === 'streaming' && after.view).toEqual(
      before.phase === 'streaming' ? before.view : null,
    );
  });
});

describe('the end of it', () => {
  it('is failed when something went wrong, with the words the server chose', () => {
    const state = run(...watching(), { type: 'failed', message: 'Please try asking again.' });

    expect(state).toEqual({ phase: 'failed', message: 'Please try asking again.' });
    // A failure is not busy: the composer takes the next question.
    expect(isBusy(state)).toBe(false);
  });

  it('is idle once the finished message belongs to the history', () => {
    expect(run(...watching(), { type: 'idle' })).toEqual(IDLE);
  });
});
