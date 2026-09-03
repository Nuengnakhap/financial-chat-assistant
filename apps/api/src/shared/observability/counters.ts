import { Injectable } from '@nestjs/common';

/**
 * How often the things worth watching have happened since this process started.
 *
 * **Why counters and not OpenTelemetry.** Two monitoring layers in the security
 * model wait on "a metric" — the rate of unverifiable claims, and the rate of
 * SQL the policy refused — and both were written as though a collector existed.
 * None does, and a metrics registry with nothing collecting from it is the same
 * thing as a kill switch with no dashboard: two code paths to maintain in
 * exchange for a number nobody reads. This system runs on one machine under
 * Docker Compose, deliberately (`AGENTS.md`), so the honest shape of "where are
 * the numbers" is: in the process, on the health endpoint, gone on restart.
 *
 * That last part is a property, not an apology. A counter that survives a
 * restart is a store, and a store needs a schema, a retention policy and
 * somebody to run it. What this answers is "what has this process been seeing",
 * which is the question somebody actually asks while watching it.
 *
 * The day there is a collector, this is the one place that changes: every call
 * site already says *what* happened, and an OTel counter would be the same call
 * with a different implementation behind it.
 *
 * **What is not here, and why.** "How often did it fall back to the rows" would
 * be worth knowing and is not counted: the outcome that says so is visible only
 * inside the runner, and reaching it would mean widening an interface so a
 * counter could see it. A number is not worth reshaping a boundary for. The two
 * counted below cover the same ground from the other side — a fallback is
 * always preceded by the resets that led to it.
 *
 * **Nothing here is a value from a request.** A counter name is a constant from
 * the closed union below, and a label is one of a fixed set — the same rule
 * `LogContext` follows, for the same reason: a metric keyed on user input is an
 * unbounded map somebody can grow from outside.
 */

/**
 * A union rather than an array of constants, unlike `SqlRule` and
 * `DomainEventType` next door: nothing iterates these, and an array kept only
 * to derive a type from is a value that has to be exported to stop the dead-code
 * check calling it dead.
 */
export type CounterName =
  /**
   * A finished draft the verifier refused, so the rows themselves were shown
   * instead. Not the same event as the one below, and the distinction is the
   * point: this one was read whole.
   */
  | 'grounding.violation'
  /**
   * A draft thrown away and asked for again — the claim gate stopping a figure
   * mid-sentence, before a reader saw it. The headline number.
   */
  | 'generation.draft_reset'
  /** SQL the policy refused, labelled with which rule refused it. */
  | 'sql.refused'
  /** A question refused because the window was spent. */
  | 'budget.denied'
  /** A question refused because they arrived too fast. */
  | 'send.throttled';

/**
 * Every label any counter may carry, which today is the reasons the SQL policy
 * refuses a statement.
 *
 * Written out here rather than imported, so that `shared/` does not learn the
 * vocabulary of a bounded context — and held to `SqlRule` by an `Assert` in the
 * decorator that produces them, the same way `ApiErrorCode` is held to cover
 * every `DomainErrorCode`. Adding a rule without adding it here is a build
 * failure, which is the only kind of reminder that works.
 */
export type CounterLabel =
  | 'length'
  | 'syntax'
  | 'empty'
  | 'multiple_statements'
  | 'not_a_select'
  | 'no_result_columns'
  | 'duplicate_column'
  | 'construct'
  | 'table'
  | 'no_table'
  | 'column'
  | 'function'
  | 'type';

@Injectable()
export class Counters {
  private readonly counts = new Map<string, number>();

  /**
   * A label is a value from `CounterLabel` and can never be one from a request:
   * a metric keyed on user input is an unbounded map somebody can grow from
   * outside. The type is what says so — the sentence used to, and a sentence is
   * not a constraint.
   */
  count(name: CounterName, label?: CounterLabel): void {
    const key = label === undefined ? name : `${name}{${label}}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Sorted, so two readings of an unchanged process are the same bytes. */
  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}
