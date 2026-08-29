/**
 * A failure the caller is expected to handle belongs in the signature, not
 * thrown past it. `throw` is reserved for bugs.
 *
 * `Ok` and `Err` are deliberately both a type and a constructor; TypeScript
 * keeps the two in separate namespaces.
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function Ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function Err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export function mapOk<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? Ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : Err(fn(result.error));
}

export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** For work where partial success is meaningless: half a verified answer is still unshowable. */
export function allOk<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return Ok(values);
}

/** Only where a failure would mean the program is already broken — never to skip handling one. */
export function expectOk<T, E>(result: Result<T, E>, context: string): T {
  if (result.ok) return result.value;
  throw new Error(`${context}: ${describeError(result.error)}`, { cause: result.error });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
