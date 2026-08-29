import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Returns a placeholder outside a request rather than throwing: a log line from
 * a background task is still worth having, and a missing id must never be the
 * reason an error is swallowed.
 */
export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? 'no-request';
}

/** Accepts an inbound id so a trace survives across services, but never trusts its shape. */
export function toRequestId(header: unknown): string {
  return typeof header === 'string' && /^[\w-]{1,128}$/.test(header) ? header : randomUUID();
}
