import type { GroundingReport, StreamEvent } from '@fca/contracts';
import { MessageId } from '@fca/domain';
import { describe, expect, it } from 'vitest';

import { Counters } from '../../../shared/observability/counters';
import { CountingGenerationEvents } from '../counting-generation-events';
import type { GenerationStream } from '../generation-stream';

/**
 * The decorator earns its place by being removable: take the binding out and
 * the system behaves identically, minus the numbers. What these pin is that it
 * counts the two things that are not the same refusal, and passes everything
 * through unchanged.
 */

const ANSWER = MessageId.trusted('a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d');

const failed: GroundingReport = {
  verdict: 'fail',
  checkedClaims: [],
  violations: [{ text: '$999.9B', reason: 'no_evidence' }],
};
const passed: GroundingReport = { verdict: 'pass', checkedClaims: [], violations: [] };

function counting(): { readonly events: CountingGenerationEvents; readonly seen: StreamEvent[] } {
  const seen: StreamEvent[] = [];
  const inner = {
    append: async (_id: MessageId, event: StreamEvent) => {
      seen.push(event);
      await Promise.resolve();
    },
  } as unknown as GenerationStream;

  return { events: new CountingGenerationEvents(inner, new Counters()), seen };
}

const countsAfter = async (...written: StreamEvent[]): Promise<Record<string, number>> => {
  const counters = new Counters();
  const inner = { append: async () => await Promise.resolve() } as unknown as GenerationStream;
  const events = new CountingGenerationEvents(inner, counters);
  for (const event of written) await events.append(ANSWER, event);

  return { ...counters.snapshot() };
};

describe('counting what a generation turned out to be', () => {
  it('counts a draft the gate stopped', async () => {
    // The gate produces no report at all — it stops mid-sentence — so counting
    // only reports would miss the half that matters most.
    const counts = await countsAfter({
      type: 'draft_reset',
      attempt: 2,
      reason: 'unverifiable_claim',
    });

    expect(counts).toEqual({ 'generation.draft_reset': 1 });
  });

  it('counts a draft the verifier refused', async () => {
    expect(await countsAfter({ type: 'verification', report: failed })).toEqual({
      'grounding.violation': 1,
    });
  });

  it('counts nothing for a draft that verified', async () => {
    expect(await countsAfter({ type: 'verification', report: passed })).toEqual({});
  });

  it('counts nothing for the events that are not about being refused', async () => {
    expect(
      await countsAfter(
        { type: 'text_delta', delta: 'Apple' },
        { type: 'reconnect_hint' },
        { type: 'tool_call_ready', id: 'call_1', sql: 'SELECT 1' },
      ),
    ).toEqual({});
  });

  it('counts nothing for an event that was never written', async () => {
    // A write that throws is a thing that did not happen. Counting before the
    // await would record it anyway, and a number that overstates is the one a
    // reader trusts most.
    const counters = new Counters();
    const refusing = {
      append: async () => await Promise.reject(new Error('redis is gone')),
    } as unknown as GenerationStream;
    const events = new CountingGenerationEvents(refusing, counters);

    await expect(
      events.append(ANSWER, { type: 'draft_reset', attempt: 2, reason: 'unverifiable_claim' }),
    ).rejects.toThrow('redis is gone');
    expect(counters.snapshot()).toEqual({});
  });

  it('hands every event on unchanged', async () => {
    // The whole of what it must not do. A decorator that swallowed an event
    // would take an answer off somebody's screen to keep a number.
    const { events, seen } = counting();
    const written: StreamEvent[] = [
      { type: 'draft_reset', attempt: 2, reason: 'unverifiable_claim' },
      { type: 'verification', report: failed },
      { type: 'text_delta', delta: 'Apple' },
    ];

    for (const event of written) await events.append(ANSWER, event);

    expect(seen).toEqual(written);
  });
});
