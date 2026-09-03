import type { StreamEvent } from '@fca/contracts';
import { MessageId } from '@fca/domain';
import { describe, expect, it } from 'vitest';

import {
  STREAM_START,
  type GenerationEvents,
  type StoredStreamEvent,
} from '../generation-events.port';

/**
 * One set of questions, asked of every adapter behind `GenerationEvents`.
 *
 * These are the sentences the rest of the system is written on top of, so they
 * belong to the port rather than to whoever implements it today: a use case that
 * resumes from an id, a janitor that decides a runner is dead from when the
 * stream last moved, and a connection that hangs up mid-answer are all relying
 * on something here. An adapter passing this suite unchanged is what "swap the
 * infrastructure" means in `CONTRIBUTING.md`; an adapter that needs the suite edited has
 * changed the contract, not the implementation.
 *
 * Nothing here mentions Redis, a key, a consumer group or a TTL. Those are
 * properties of one adapter and are proven beside it.
 */

const text = (delta: string): StreamEvent => ({ type: 'text_delta', delta });
const ended: StreamEvent = { type: 'error', code: 'generation_failed', message: 'no' };

/** A fresh generation per case, so no adapter needs a way to be emptied. */
const anotherGeneration = (): MessageId => MessageId.trusted(crypto.randomUUID());

const said = (events: readonly StoredStreamEvent[]): readonly string[] =>
  events.map((stored) =>
    stored.event.type === 'text_delta' ? stored.event.delta : stored.event.type,
  );

export function generationEventsContract(name: string, connect: () => GenerationEvents): void {
  describe(`GenerationEvents contract: ${name}`, () => {
    async function drain(
      events: GenerationEvents,
      answer: MessageId,
      afterId = STREAM_START,
    ): Promise<readonly StoredStreamEvent[]> {
      const seen: StoredStreamEvent[] = [];
      for await (const stored of events.read(answer, afterId, new AbortController().signal)) {
        seen.push(stored);
      }

      return seen;
    }

    it('replays what was missed, then keeps going with what happens next', async () => {
      // The two halves of resuming. A reader that only replays stops at the
      // last thing written before it arrived; one that only tails loses the
      // beginning of an answer already in progress.
      const events = connect();
      const answer = anotherGeneration();
      await events.append(answer, text('before'));

      const reading = drain(events, answer);
      await events.append(answer, text('during'));
      await events.append(answer, ended);

      expect(said(await reading)).toEqual(['before', 'during', 'error']);
    });

    it('gives every event an id, and resuming from one repeats nothing', async () => {
      const events = connect();
      const answer = anotherGeneration();
      await events.append(answer, text('one'));
      await events.append(answer, text('two'));
      await events.append(answer, ended);

      const all = await events.replay(answer);

      expect(all.every((stored) => stored.id !== null)).toBe(true);
      expect(said(await drain(events, answer, all[0]?.id ?? STREAM_START))).toEqual([
        'two',
        'error',
      ]);
    });

    it('ends at the terminal event, whatever was written after it', async () => {
      // A janitor and a runner can both decide a generation is over. Whichever
      // writes second must not read as more answer arriving.
      const events = connect();
      const answer = anotherGeneration();
      await events.append(answer, ended);
      await events.append(answer, text('and then'));

      expect(said(await drain(events, answer))).toEqual(['error']);
      expect(said(await events.replay(answer))).toEqual(['error']);
    });

    it('has nothing to say about a generation nobody has written to', async () => {
      const events = connect();

      await expect(events.replay(anotherGeneration())).resolves.toEqual([]);
      await expect(events.lastActivityAt(anotherGeneration())).resolves.toBeNull();
    });

    it('keeps what was appended in order in that order', async () => {
      const events = connect();
      const answer = anotherGeneration();
      const words = Array.from({ length: 40 }, (_unused, index) => String(index));

      for (const word of words) {
        // eslint-disable-next-line no-await-in-loop -- the order is the assertion.
        await events.append(answer, text(word));
      }
      await events.append(answer, ended);

      expect(said(await events.replay(answer)).slice(0, -1)).toEqual(words);
    });

    it('resumes from an id correctly however many events there are', async () => {
      // The tenth event is where an id compared as text starts lying: "1-10"
      // sorts before "1-9". A reader resuming from the ninth would then be
      // handed the whole answer again, or none of it — and neither shows up in
      // a stream short enough to fit in one digit, which is every test that
      // does not deliberately write eleven.
      const events = connect();
      const answer = anotherGeneration();
      const words = Array.from({ length: 12 }, (_unused, index) => `w${String(index)}`);

      for (const word of words) {
        // eslint-disable-next-line no-await-in-loop -- ids have to be handed out in order.
        await events.append(answer, text(word));
      }
      await events.append(answer, ended);

      const all = await events.replay(answer);
      const ninth = all[8];

      expect(said(await drain(events, answer, ninth?.id ?? STREAM_START))).toEqual([
        ...words.slice(9),
        'error',
      ]);
    });

    it('reads when a generation was last heard from out of the stream itself', async () => {
      // What says a runner is alive. The process cannot be asked — it may be
      // gone — so the answer has to come from what it left behind. An adapter
      // whose ids do not carry a time has to find one somewhere else, and this
      // is where it is told so.
      const events = connect();
      const answer = anotherGeneration();
      const before = Date.now();
      await events.append(answer, text('alive'));

      const at = await events.lastActivityAt(answer);

      expect(at).toBeInstanceOf(Date);
      expect(at?.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(at?.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    });

    it('lets go when the reader does, without waiting for the generation to end', async () => {
      // A closed tab. The generation carries on; this particular reading of it
      // does not, and it must not hold anything open waiting for a terminal
      // event that is minutes away.
      const events = connect();
      const answer = anotherGeneration();
      const controller = new AbortController();
      await events.append(answer, text('watching'));

      const seen: StoredStreamEvent[] = [];
      const reading = (async (): Promise<void> => {
        for await (const stored of events.read(answer, STREAM_START, controller.signal)) {
          seen.push(stored);
          controller.abort();
        }
      })();

      await expect(reading).resolves.toBeUndefined();
      expect(said(seen)).toEqual(['watching']);
    });
  });
}
