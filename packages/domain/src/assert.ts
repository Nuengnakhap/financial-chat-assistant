/**
 * Closes a `switch` over a union: adding a variant then breaks compilation
 * everywhere it is unhandled. Reaching this at runtime means a value crossed a
 * boundary without being parsed — a bug there, not here.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled variant in ${context}: ${safeDescribe(value)}`);
}

function safeDescribe(value: unknown): string {
  // The three inputs for which JSON.stringify returns undefined, which the lib
  // types do not admit.
  const type = typeof value;
  if (type === 'undefined' || type === 'function' || type === 'symbol') return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    // An unserialisable value must not mask the error being reported.
    return Object.prototype.toString.call(value);
  }
}
