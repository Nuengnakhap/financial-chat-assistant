import { apiFailure, authContract, CSRF_HEADER, SESSION_COOKIE } from '@fca/contracts';

import { ApiError, NetworkError } from './errors';
import { announceSessionExpired } from './session-expiry';

function readCsrfCookie(): string {
  const match = new RegExp(`(?:^|; )${SESSION_COOKIE.csrf}=([^;]*)`).exec(document.cookie);
  const raw = match?.[1];
  if (raw === undefined) return '';

  try {
    return decodeURIComponent(raw);
  } catch {
    // A value that is not valid percent-encoding is somebody else's doing —
    // ports share a cookie jar, so anything else on localhost can write this
    // name. Send it as it stands and let the server reject the mismatch. This
    // runs inside the try in `send()`, so throwing here would surface as
    // "cannot reach the server", which is the one thing it is not.
    return raw;
  }
}

/** An abandoned request is not a failure, and must not be reported as one. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * One refresh at a time, shared by everything that got a 401 while it was
 * running. This is not an optimisation: the refresh token rotates on every use,
 * so five concurrent refreshes present the same token five times, and the server
 * reads a token presented twice as stolen and revokes the whole lineage. Racing
 * here signs the person out.
 */
async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= sendRefresh().finally(() => {
    refreshInFlight = null;
  });
  return await refreshInFlight;
}

/**
 * Deliberately carries no signal. The refresh is shared, so one caller
 * navigating away must not cancel the rotation everyone else is waiting on.
 */
async function sendRefresh(): Promise<boolean> {
  try {
    const response = await fetch(authContract.refresh.path, {
      method: authContract.refresh.method,
      credentials: 'include',
      headers: headersFor({}),
      body: '{}',
    });
    return response.ok;
  } catch {
    return false;
  }
}

function headersFor(body: unknown): Record<string, string> {
  // The CSRF echo goes on every request, not only on mutations. The guard fires
  // whenever a session cookie is present rather than for a list of routes, so
  // `login` can answer 403 to someone who still has a cookie from last time —
  // and a rule with an exception is a rule somebody forgets at the one call site
  // that needed it.
  const headers: Record<string, string> = { [CSRF_HEADER]: readCsrfCookie() };
  // Only when something is actually being sent. Declaring JSON and then sending
  // nothing is what makes Fastify answer 400 — measured against the real server,
  // where a mocked 200 had hidden it.
  if (body !== undefined) headers['content-type'] = 'application/json';
  return headers;
}

/**
 * The endpoints that establish a session rather than consume one. A 401 from any
 * of these means the credentials were wrong — refreshing would spend a request
 * to be refused again, and would announce an expired session to someone who is
 * standing on the sign-in form and never had one.
 */
const ESTABLISHES_SESSION: ReadonlySet<string> = new Set([
  authContract.login.path,
  authContract.register.path,
  authContract.refresh.path,
]);

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  /** The status the contract says this answers with, when it says. */
  readonly expect?: number;
  /** Aborted when the caller goes away, so the request stops rather than lingering. */
  readonly signal?: AbortSignal;
}

/**
 * Every request the application makes. Attaches the session cookies and the CSRF
 * echo, and turns a 401 into exactly one refresh-and-retry: if the second
 * attempt is refused as well, the problem is not an expired token and repeating
 * is a loop.
 */
export async function apiFetch(request: ApiRequest): Promise<unknown> {
  const response = await send(request);
  if (response.status !== 401 || ESTABLISHES_SESSION.has(request.path)) {
    return await parse(response, request.expect);
  }

  const refreshed = await refreshSession();
  if (!refreshed) {
    announceSessionExpired();
    return await parse(response, request.expect);
  }
  return await parse(await send(request), request.expect);
}

async function send(request: ApiRequest): Promise<Response> {
  try {
    return await fetch(request.path, {
      method: request.method,
      credentials: 'include',
      headers: headersFor(request.body),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error) {
    // An abort is the caller's own doing. Reporting it as a network failure
    // would put "cannot reach the server" on screen every time a route changes.
    if (isAbort(error)) throw error;
    throw new NetworkError();
  }
}

async function parse(response: Response, expect: number | undefined): Promise<unknown> {
  const payload: unknown = await response.json().catch(() => null);

  if (response.ok) {
    // A 200 where the contract promised a 201 is not a success anyone asked
    // for: something is answering that is not the route the contract describes,
    // and the body is about to be parsed as though it were.
    if (expect !== undefined && response.status !== expect) {
      throw new ApiError({
        code: 'internal',
        status: response.status,
        message: 'Something went wrong on our side.',
      });
    }
    return payload;
  }

  const failure = apiFailure.safeParse(payload);
  throw new ApiError({
    // A body that is not the envelope means the failure never reached the
    // filter — a proxy, or the process being gone. It is still a real status.
    code: failure.success ? failure.data.code : 'internal',
    status: response.status,
    message: failure.success ? failure.data.message : 'Something went wrong on our side.',
    ...retryAfter(response),
  });
}

/**
 * Opens an event stream, with the same session handling every other request
 * gets: the cookies, the CSRF echo, and one refresh-and-retry on a 401 — a
 * generation outlives an access token, so a stream that reconnects after fifteen
 * minutes would otherwise be refused for ever.
 *
 * Answers with the body rather than the response, because a stream that arrived
 * without one is a failure, and finding that out inside the reading loop would
 * put it three frames from the request that caused it.
 */
export async function openStream(
  path: string,
  lastEventId: string | null,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await sendStream(path, lastEventId, signal);
  if (response.status !== 401) return await bodyOf(response);

  const refreshed = await refreshSession();
  if (!refreshed) {
    announceSessionExpired();
    return await bodyOf(response);
  }

  return await bodyOf(await sendStream(path, lastEventId, signal));
}

async function sendStream(
  path: string,
  lastEventId: string | null,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(path, {
      method: 'GET',
      credentials: 'include',
      headers: {
        ...headersFor(undefined),
        accept: 'text/event-stream',
        ...(lastEventId === null ? {} : { 'last-event-id': lastEventId }),
      },
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new NetworkError();
  }
}

async function bodyOf(response: Response): Promise<ReadableStream<Uint8Array>> {
  // `parse` throws the failure the envelope describes, which is what a 404 for
  // somebody else's message has to become.
  if (!response.ok) await parse(response, undefined);
  if (response.body === null) throw new NetworkError();

  return response.body;
}

function retryAfter(response: Response): { retryAfterSeconds?: number } {
  const header = response.headers.get('retry-after');
  if (header === null) return {};
  const seconds = Number(header);
  return Number.isFinite(seconds) ? { retryAfterSeconds: seconds } : {};
}
