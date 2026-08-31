/**
 * Joins the class names that are actually strings. A dependency for this would
 * be three lines of code and a supply-chain decision.
 */
export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
}
