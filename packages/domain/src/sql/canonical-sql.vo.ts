/**
 * SQL that has been through the policy — and the only kind anything in this
 * system will run.
 *
 * The guarantee lives in the type rather than in a rule anyone has to remember:
 * the query port takes a `CanonicalSql`, so "execute this string the model
 * wrote" is not a sentence that can be written. What reaches the database is
 * always the deparsed form of an abstract syntax tree that was walked and
 * accepted, never the text that was sent in.
 *
 * `deparsed` is private for a reason that is easy to miss: a class whose members
 * are all public is satisfied by any object of the same shape, so without it
 * `{ text: 'DROP TABLE financial_data' }` would be a `CanonicalSql` as far as
 * the compiler is concerned.
 */
export class CanonicalSql {
  private constructor(private readonly deparsed: string) {}

  /**
   * The one way to make one. Named to be conspicuous at a call site, because
   * the only legitimate call site is the SQL policy adapter — which is where a
   * lint rule keeps it.
   */
  static __fromPolicy(deparsed: string): CanonicalSql {
    return new CanonicalSql(deparsed);
  }

  get text(): string {
    return this.deparsed;
  }
}
