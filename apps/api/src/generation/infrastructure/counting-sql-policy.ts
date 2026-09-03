import type { Result } from '@fca/domain';
import { Injectable } from '@nestjs/common';

import { PgAstSqlPolicy } from './pg-ast-sql-policy';
import { Counters, type CounterLabel } from '../../shared/observability/counters';
import type {
  QueryPlan,
  SqlPolicy,
  SqlRule,
  SqlViolation,
} from '../application/ports/sql-policy.port';

/**
 * The labels this decorator produces are rules, and `Counters` says which
 * labels exist. Nothing checks that those two lists agree at runtime — the
 * token is resolved by name — so this makes a rule added on one side and not
 * the other a build failure, the way `DomainErrorCode ⊆ ApiErrorCode` is held.
 */
type Assert<T extends true> = T;
type _EveryRuleIsALabel = Assert<SqlRule extends CounterLabel ? true : false>;

/**
 * Counts refusals by the rule that refused them, and does nothing else.
 *
 * A decorator so that the policy stays what it is: a pure function of a string,
 * with no state and nothing to reset between calls. Instrumenting it in place
 * would give the one class in the system whose whole value is being pure a
 * reason to hold a collaborator.
 *
 * Per rule rather than in total, which the port asked for in writing before
 * anything counted: a spike in `table` or `construct` is a model with a broken
 * idea of the schema, and a spike in `syntax` is somebody probing. One number
 * for both says a thing is happening and not which.
 */
@Injectable()
export class CountingSqlPolicy implements SqlPolicy {
  constructor(
    private readonly inner: PgAstSqlPolicy,
    private readonly counters: Counters,
  ) {}

  validate(raw: string): Result<QueryPlan, SqlViolation> {
    const verdict = this.inner.validate(raw);
    if (!verdict.ok) this.counters.count('sql.refused', verdict.error.rule);

    return verdict;
  }
}
