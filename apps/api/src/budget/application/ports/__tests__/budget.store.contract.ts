import { MicroUsd, UserId } from '@fca/domain';
import { describe, expect, it } from 'vitest';

import type { BudgetStore } from '../budget.store';

/**
 * One set of questions, asked of every adapter behind `BudgetStore`.
 *
 * Two phases, because one is not enough: the port promises that
 * `spent + reserved ≤ limit` is arithmetic rather than a race, and that giving
 * a claim back and recording what it cost each happen once however many times
 * they are asked for — a stopped generation, a janitor and a shutdown hook can
 * all decide the same reservation is finished.
 *
 * What is deliberately **not** here: that the steps are atomic under load. That
 * is a property of the scripts, it cannot be shown by a double running in one
 * thread, and it is proven against a real Redis beside the adapter that has it.
 */

export interface BudgetUnderTest {
  readonly store: BudgetStore;
  /** What the store was built to allow, so the cases can spend up to it. */
  readonly limit: MicroUsd;
}

/** Nobody has spent anything, so no adapter needs a way to be emptied. */
const somebodyNew = (): UserId => UserId.trusted(crypto.randomUUID());

export function budgetStoreContract(name: string, connect: () => BudgetUnderTest): void {
  describe(`BudgetStore contract: ${name}`, () => {
    it('starts a window at nothing spent, nothing held, and an end in the future', async () => {
      const { store, limit } = connect();

      const state = await store.read(somebodyNew());

      expect(state.spent.isZero).toBe(true);
      expect(state.reserved.isZero).toBe(true);
      expect(state.limit.equals(limit)).toBe(true);
      // In the future, not merely "after 1970". A store that handed back the
      // start of the window instead of its end would pass that, and a meter
      // fed by it would show a limit that reset in the past for ever.
      expect(state.resetAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('holds what a generation might cost before it costs it', async () => {
      // Not "check the total, then add to it". What is held is gone as far as
      // the next question is concerned, which is the only reading under which
      // two arriving at once cannot both be told yes.
      const { store, limit } = connect();
      const ada = somebodyNew();

      const held = await store.reserve(ada, limit);

      expect(held).not.toBeNull();
      const state = await store.read(ada);
      expect(state.reserved.equals(limit)).toBe(true);
      expect(state.spent.isZero).toBe(true);
    });

    it('refuses when what is left will not cover it', async () => {
      const { store, limit } = connect();
      const ada = somebodyNew();
      await store.reserve(ada, limit);

      // Nothing has been spent yet — and it still has to be refused, because
      // the money is promised to an answer that is being written.
      await expect(store.reserve(ada, MicroUsd.fromMicro(1n))).resolves.toBeNull();
    });

    it('records what was actually spent and gives back the rest', async () => {
      const { store, limit } = connect();
      const ada = somebodyNew();
      const held = await store.reserve(ada, limit);
      if (held === null) throw new Error('the first reservation in an empty window was refused');

      const actual = limit.dividedBy(4n, 'down');
      await store.settle(held, actual);

      const state = await store.read(ada);
      expect(state.spent.equals(actual)).toBe(true);
      expect(state.reserved.isZero).toBe(true);
      // The three quarters that were held and not spent are available again.
      await expect(store.reserve(ada, limit.dividedBy(2n, 'down'))).resolves.not.toBeNull();
    });

    it('settles once however many times it is told to', async () => {
      const { store, limit } = connect();
      const ada = somebodyNew();
      const held = await store.reserve(ada, limit);
      if (held === null) throw new Error('the first reservation in an empty window was refused');
      const actual = limit.dividedBy(4n, 'down');

      await store.settle(held, actual);
      await store.settle(held, actual);
      await store.settle(held, actual);

      // Otherwise a shutdown hook running after a runner already finished
      // charges somebody three times for one answer.
      const state = await store.read(ada);
      expect(state.spent.equals(actual)).toBe(true);
      expect(state.reserved.isZero).toBe(true);
    });

    it('gives a claim back without charging for it, once', async () => {
      const { store, limit } = connect();
      const ada = somebodyNew();
      const held = await store.reserve(ada, limit);
      if (held === null) throw new Error('the first reservation in an empty window was refused');

      await store.release(held);
      await store.release(held);

      const state = await store.read(ada);
      expect(state.spent.isZero).toBe(true);
      expect(state.reserved.isZero).toBe(true);
      await expect(store.reserve(ada, limit)).resolves.not.toBeNull();
    });

    it('ignores a release that arrives after the settle', async () => {
      // Both paths fire for a generation that was stopped while finishing. The
      // second one must not hand back money that has already been charged.
      const { store, limit } = connect();
      const ada = somebodyNew();
      const held = await store.reserve(ada, limit);
      if (held === null) throw new Error('the first reservation in an empty window was refused');
      const actual = limit.dividedBy(2n, 'down');

      await store.settle(held, actual);
      await store.release(held);

      // Both halves. A release that still gives the hold back after the money
      // has been charged hands the spending power out twice, and a store that
      // did that would pass every other case in this file.
      await expect(store.read(ada)).resolves.toMatchObject({
        spent: expect.objectContaining({ micro: actual.micro }),
        reserved: expect.objectContaining({ micro: 0n }),
      });
    });

    it('answers without changing the answer', async () => {
      const { store, limit } = connect();
      const ada = somebodyNew();
      await store.reserve(ada, limit.dividedBy(2n, 'down'));

      const first = await store.read(ada);
      const second = await store.read(ada);

      expect(second.spent.equals(first.spent)).toBe(true);
      expect(second.reserved.equals(first.reserved)).toBe(true);
    });

    it('keeps one person’s window out of another’s', async () => {
      const { store, limit } = connect();
      const ada = somebodyNew();
      const grace = somebodyNew();

      await store.reserve(ada, limit);

      await expect(store.reserve(grace, limit)).resolves.not.toBeNull();
      expect((await store.read(grace)).reserved.equals(limit)).toBe(true);
    });

    it('records an answer that cost more than it promised to', async () => {
      // The model wrote more than the estimate allowed for. Recording the
      // estimate instead would make the ledger a record of what was expected.
      const { store, limit } = connect();
      const ada = somebodyNew();
      const held = await store.reserve(ada, limit.dividedBy(4n, 'down'));
      if (held === null) throw new Error('a quarter of an empty window was refused');

      await store.settle(held, limit);

      const state = await store.read(ada);
      expect(state.spent.equals(limit)).toBe(true);
      await expect(store.reserve(ada, MicroUsd.fromMicro(1n))).resolves.toBeNull();
    });
  });
}
