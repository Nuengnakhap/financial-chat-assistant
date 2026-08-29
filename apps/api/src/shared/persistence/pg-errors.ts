/** PostgreSQL `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * Drizzle wraps the driver error, so the SQLSTATE and the constraint name live
 * somewhere down the `cause` chain. Matching on the constraint by name matters:
 * a clash on the sequence number is a race worth retrying, while a clash on the
 * client message id is the idempotency guarantee working and must be reported.
 */
export function isUniqueViolationOf(error: unknown, constraint: string): boolean {
  let current: unknown = error;

  while (current !== null && current !== undefined) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      current.code === UNIQUE_VIOLATION &&
      'constraint' in current &&
      current.constraint === constraint
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}
