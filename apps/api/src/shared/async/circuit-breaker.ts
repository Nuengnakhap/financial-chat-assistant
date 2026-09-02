/**
 * Stops asking something that has stopped answering.
 *
 * Retries are the provider SDK's job and it does them well — it knows which of
 * its own status codes are worth repeating and reads `retry-after` when one
 * comes back. What no client library does is notice that the last five calls all
 * failed and that the sixth is a wasted sixty seconds. That is this.
 *
 * Three states and one number between them: closed while calls succeed, open for
 * a fixed pause once failures pile up, then a single trial call — half-open —
 * whose result decides which of the two it goes back to. The pause is what makes
 * an outage cost one slow request instead of one per caller.
 */

export class CircuitOpenError extends Error {
  constructor(readonly reopensInMs: number) {
    super('The circuit is open after repeated failures.');
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open it. One flake should not stop everything. */
  readonly failuresBeforeOpening: number;
  readonly openForMs: number;
  /**
   * Which errors say something about the thing being called. Everything counts
   * by default, and the caller narrows that where it knows better: a caller who
   * cancelled is not evidence that the endpoint has stopped answering, and
   * counting it would let somebody pressing stop five times close the door on
   * everyone else.
   */
  readonly countsAsFailure?: (error: unknown) => boolean;
  /** Injected so a test can decide what time it is rather than wait for it. */
  readonly now?: () => number;
}

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;
  /** Set while the one trial call of a half-open circuit is in flight. */
  private trialInFlight = false;
  private readonly now: () => number;
  private readonly countsAsFailure: (error: unknown) => boolean;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
    this.countsAsFailure = options.countsAsFailure ?? (() => true);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const trial = this.admit();

    try {
      const value = await work();
      this.onSuccess();
      return value;
    } catch (error) {
      // An error that says nothing about the endpoint leaves the count alone —
      // neither a failure nor a success, because it is neither.
      if (this.countsAsFailure(error)) this.onFailure();
      throw error;
    } finally {
      if (trial) this.trialInFlight = false;
    }
  }

  /** Whether the call about to run is the trial one, or throws if none may run. */
  private admit(): boolean {
    if (this.openedAtMs === null) return false;

    const elapsed = this.now() - this.openedAtMs;
    if (elapsed < this.options.openForMs) {
      throw new CircuitOpenError(this.options.openForMs - elapsed);
    }
    // One at a time while it is being tried: a hundred callers arriving the
    // moment the pause ends would all be sent at a service that is probably
    // still down, which is the stampede the pause exists to prevent.
    if (this.trialInFlight) throw new CircuitOpenError(this.options.openForMs);

    this.trialInFlight = true;
    return true;
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    // A failed trial reopens for the whole pause again rather than for what was
    // left of the last one.
    if (
      this.consecutiveFailures >= this.options.failuresBeforeOpening ||
      this.openedAtMs !== null
    ) {
      this.openedAtMs = this.now();
    }
  }
}
