import { MicroUsd, ReservationId, type Reservation, type UserId } from '@fca/domain';

import type { BudgetState, BudgetStore } from '../budget.store';

/**
 * A second implementation, so the suite next door is the port's and not one
 * adapter's. It is deliberately not a translation of the Lua: it keeps three
 * numbers and a set of outstanding claims, which is the smallest thing that can
 * answer every question the contract asks.
 *
 * It cannot stand in for the real one anywhere that matters. The scripts exist
 * because reserving has to be a single step, and a double running in one thread
 * has already lost the interleaving that would break it — which is why the
 * concurrency property lives beside the Redis adapter and not in the contract.
 */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly spent = new Map<string, MicroUsd>();
  private readonly held = new Map<string, MicroUsd>();
  /** Claims not yet given back. A claim settled twice is only in here once. */
  private readonly outstanding = new Map<string, MicroUsd>();

  constructor(
    private readonly limit: MicroUsd,
    private readonly windowStart = new Date(),
    private readonly windowSeconds = 3_600,
  ) {}

  reserve(userId: UserId, amount: MicroUsd): Promise<Reservation | null> {
    const after = this.spentBy(userId).plus(this.heldBy(userId)).plus(amount);
    if (after.isGreaterThan(this.limit)) return Promise.resolve(null);

    const id = ReservationId.trusted(crypto.randomUUID());
    this.held.set(userId, this.heldBy(userId).plus(amount));
    this.outstanding.set(id, amount);

    return Promise.resolve({ userId, id, windowStart: this.windowStart });
  }

  settle(reservation: Reservation, actual: MicroUsd): Promise<void> {
    const amount = this.outstanding.get(reservation.id);
    if (amount === undefined) return Promise.resolve();
    this.outstanding.delete(reservation.id);

    this.held.set(reservation.userId, this.heldBy(reservation.userId).minus(amount));
    this.spent.set(reservation.userId, this.spentBy(reservation.userId).plus(actual));

    return Promise.resolve();
  }

  release(reservation: Reservation): Promise<void> {
    return this.settle(reservation, MicroUsd.ZERO);
  }

  read(userId: UserId): Promise<BudgetState> {
    return Promise.resolve({
      spent: this.spentBy(userId),
      reserved: this.heldBy(userId),
      limit: this.limit,
      resetAt: new Date(this.windowStart.getTime() + this.windowSeconds * 1_000),
    });
  }

  private spentBy(userId: UserId): MicroUsd {
    return this.spent.get(userId) ?? MicroUsd.ZERO;
  }

  private heldBy(userId: UserId): MicroUsd {
    return this.held.get(userId) ?? MicroUsd.ZERO;
  }
}
