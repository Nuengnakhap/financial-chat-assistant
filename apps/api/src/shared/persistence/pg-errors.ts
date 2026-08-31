/** PostgreSQL `unique_violation` and `foreign_key_violation`. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Drizzle wraps the driver error, so the SQLSTATE and the constraint name live
 * somewhere down the `cause` chain. Matching on the constraint by name matters:
 * a clash on the sequence number is a race worth retrying, while a clash on the
 * client message id is the idempotency guarantee working and must be reported.
 */
export function isUniqueViolationOf(error: unknown, constraint: string): boolean {
  return violates(error, UNIQUE_VIOLATION, constraint);
}

/**
 * A row that was there when it was read and gone by the time it was written to.
 * Distinguishable from a bug only by which constraint fired, which is why this
 * takes a name rather than a code alone.
 */
export function isForeignKeyViolationOf(error: unknown, constraint: string): boolean {
  return violates(error, FOREIGN_KEY_VIOLATION, constraint);
}

function violates(error: unknown, code: string, constraint: string): boolean {
  let current: unknown = error;

  while (current !== null && current !== undefined) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      current.code === code &&
      'constraint' in current &&
      current.constraint === constraint
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}
