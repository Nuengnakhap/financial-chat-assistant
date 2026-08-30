import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { SessionId, UserId } from '@fca/domain';

/** Everything a handler is allowed to believe about who is calling. */
export interface Principal {
  readonly userId: UserId;
  readonly sessionId: SessionId;
}

export interface RequestContext {
  readonly requestId: string;
  /**
   * Filled in by the guard once a token has been verified, and only there.
   * Living here rather than on the request object is what stops a use case
   * having to be handed a request to find out who is asking.
   */
  principal: Principal | null;
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

/**
 * Recorded on the context the request is already running inside, so it reaches
 * everything downstream without being threaded through a signature.
 */
export function setPrincipal(principal: Principal): void {
  const context = storage.getStore();
  if (context !== undefined) context.principal = principal;
}

/** `null` outside a request, and for any request that has not been through the guard. */
export function currentPrincipal(): Principal | null {
  return storage.getStore()?.principal ?? null;
}

/**
 * For a handler behind `SessionGuard`. Reaching one with no principal means the
 * route was wired without the guard — a bug, not a caller who is not signed in,
 * so it throws rather than answering 401.
 */
export function requirePrincipal(): Principal {
  const principal = currentPrincipal();
  if (principal === null) throw new Error('SessionGuard did not record a principal');

  return principal;
}

/** Accepts an inbound id so a trace survives across services, but never trusts its shape. */
export function toRequestId(header: unknown): string {
  return typeof header === 'string' && /^[\w-]{1,128}$/.test(header) ? header : randomUUID();
}
