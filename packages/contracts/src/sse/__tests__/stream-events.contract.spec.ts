import { describe, expect, it } from 'vitest';

import {
  TERMINAL_STREAM_EVENTS,
  isTerminalStreamEvent,
  parseStreamEvent,
  streamEvent,
  type StreamEventType,
} from '../stream-events.contract';

const ALL_TYPES: readonly StreamEventType[] = [
  'generation_started',
  'text_delta',
  'tool_call_delta',
  'tool_call_ready',
  'tool_result',
  'draft_reset',
  'verification',
  'usage',
  'reconnect_hint',
  'message_complete',
  'error',
];

describe('the event catalogue', () => {
  it('covers every event the stream can emit', () => {
    const declared = streamEvent.options.map((option) => option.shape.type.value);

    expect(new Set(declared)).toEqual(new Set(ALL_TYPES));
  });

  it('ends only on message_complete or error', () => {
    expect(TERMINAL_STREAM_EVENTS).toEqual(['message_complete', 'error']);
    expect(isTerminalStreamEvent({ type: 'error', code: 'x', message: 'y' })).toBe(true);
    expect(isTerminalStreamEvent({ type: 'text_delta', delta: 'hi' })).toBe(false);
  });
});

describe('forward compatibility', () => {
  it('skips an event a newer server added instead of throwing', () => {
    // The property that lets the API ship a new event without breaking open tabs.
    expect(parseStreamEvent({ type: 'chart_ready', spec: {} })).toBeNull();
  });

  it('skips a known event whose payload is malformed', () => {
    expect(parseStreamEvent({ type: 'text_delta' })).toBeNull();
    expect(parseStreamEvent({ type: 'tool_result', rowCount: -1 })).toBeNull();
  });

  it('skips anything that is not an object', () => {
    for (const raw of [null, undefined, 'text_delta', 42, []]) {
      expect(parseStreamEvent(raw)).toBeNull();
    }
  });

  it('returns a narrowed event on success', () => {
    const parsed = parseStreamEvent({ type: 'text_delta', delta: 'Revenue was ' });

    expect(parsed?.type).toBe('text_delta');
    expect(parsed !== null && parsed.type === 'text_delta' ? parsed.delta : '').toBe(
      'Revenue was ',
    );
  });
});

describe('money on the wire', () => {
  it('accepts an exact micro-USD string', () => {
    const parsed = parseStreamEvent({
      type: 'usage',
      inputTokens: 10,
      outputTokens: 20,
      costMicroUsd: '1400',
      budget: {
        spentMicroUsd: '1400',
        reservedMicroUsd: '0',
        limitMicroUsd: '1000000',
        resetAt: '2026-08-29T12:00:00.000Z',
        exceeded: false,
      },
    });

    expect(parsed?.type).toBe('usage');
  });

  it('rejects a float, which is how exactness is lost in transit', () => {
    const withCost = (costMicroUsd: unknown) =>
      parseStreamEvent({
        type: 'usage',
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd,
        budget: {
          spentMicroUsd: '0',
          reservedMicroUsd: '0',
          limitMicroUsd: '1',
          resetAt: '2026-08-29T12:00:00.000Z',
        },
      });

    expect(withCost(0.0014)).toBeNull();
    expect(withCost('0.0014')).toBeNull();
  });
});

describe('tool result previews', () => {
  const preview = (rows: number) =>
    parseStreamEvent({
      type: 'tool_result',
      toolCallId: 'call_1',
      rowCount: rows,
      preview: Array.from({ length: rows }, () => ({ company: 'Apple', revenue: 1 })),
      elapsedMs: 12,
      error: null,
    });

  it('accepts up to twenty rows', () => {
    expect(preview(20)).not.toBeNull();
  });

  it('refuses a full result set masquerading as a preview', () => {
    expect(preview(21)).toBeNull();
  });
});
