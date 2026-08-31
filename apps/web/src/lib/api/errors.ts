import type { ApiErrorCode } from '@fca/contracts';

export interface ApiErrorInit {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

/**
 * A failed request as an exception, because that is what every caller here is
 * built around: a query library treats a rejection as the error state, and a
 * returned failure would have to be re-thrown at each call site to get there.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** No response at all: the server is unreachable, not refusing. */
export class NetworkError extends Error {
  constructor() {
    super('Cannot reach the server.');
    this.name = 'NetworkError';
  }
}

/** Not signed in is an answer, not a failure — every caller has to tell them apart. */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'unauthenticated';
}

/** How long a rate-limited caller must wait, when the server said. */
export function retryAfterSeconds(error: unknown): number | undefined {
  return error instanceof ApiError ? error.retryAfterSeconds : undefined;
}

/**
 * The API writes its messages for people to read, so the only wording invented
 * here is for the cases it cannot answer at all.
 */
export function messageFor(error: unknown): string {
  if (error instanceof NetworkError) return 'Cannot reach the server. Is it running?';
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong.';
}
