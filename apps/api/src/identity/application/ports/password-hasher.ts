export interface PasswordHasher {
  hash(password: string): Promise<string>;

  /**
   * `null` means no account matched the address. The work happens anyway and
   * the answer is still false, because a login that returns faster for an
   * address nobody uses answers a question we do not want asked — and putting
   * the null case here rather than at the call site is what stops someone
   * writing the early return that gives it away.
   */
  verify(storedHash: string | null, password: string): Promise<boolean>;
}
