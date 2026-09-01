import { authContract, conversationsContract } from '@fca/contracts';
import type { z } from 'zod';

import { apiFetch } from './http';

interface Endpoint {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body?: z.ZodType;
  readonly query?: z.ZodType;
  readonly response: z.ZodType;
}

/** `/api/v1/auth/sessions/:id` becomes `{ id: string }`; a path without one becomes nothing. */
type PathParams<P extends string> = P extends `${string}:${infer Tail}`
  ? Tail extends `${infer Name}/${infer Rest}`
    ? { readonly [K in Name]: string } & PathParams<Rest>
    : { readonly [K in Tail]: string }
  : Record<never, string>;

type ParamsArg<E extends Endpoint> = keyof PathParams<E['path']> extends never
  ? unknown
  : { readonly params: PathParams<E['path']> };

/**
 * `z.object({})` means "this endpoint reads no body", so asking a caller to pass
 * `{ body: {} }` would be ceremony. Anything with a field in it is required.
 */
type BodyArg<E extends Endpoint> = E extends { readonly body: infer B extends z.ZodType }
  ? Record<string, never> extends z.input<B>
    ? unknown
    : { readonly body: z.input<B> }
  : unknown;

/**
 * The field names come from the schema; the values do not. A query string
 * carries text, and `z.coerce.number()` declares its input as `unknown`, which
 * would let a caller pass an object and have it stringified into the URL.
 */
type QueryFields<Q extends z.ZodType> = {
  readonly [Name in keyof z.input<Q>]?: string | number | null;
};

/**
 * Optional as a whole, because every paginated endpoint here holds its defaults
 * on the server: no query means the first page rather than an incomplete request.
 */
type QueryArg<E extends Endpoint> = E extends { readonly query: infer Q extends z.ZodType }
  ? { readonly query?: QueryFields<Q> }
  : unknown;

type Payload<E extends Endpoint> = ParamsArg<E> & BodyArg<E> & QueryArg<E>;

/**
 * Every call may carry a signal, whether or not it carries anything else, so a
 * caller that goes away can stop the request rather than leave it in flight.
 */
interface CallOptions {
  readonly signal?: AbortSignal;
}

/**
 * Optional as a whole when nothing in it is required — an endpoint whose only
 * payload is a query with defaults on the server is called with no arguments at
 * all, rather than with an empty object to satisfy a signature.
 */
type Operation<E extends Endpoint> =
  Record<string, never> extends Payload<E>
    ? (args?: Payload<E> & CallOptions) => Promise<z.output<E['response']>>
    : (args: Payload<E> & CallOptions) => Promise<z.output<E['response']>>;

type Client<T extends Record<string, Record<string, Endpoint>>> = {
  readonly [Group in keyof T]: { readonly [Name in keyof T[Group]]: Operation<T[Group][Name]> };
};

function fillPath(path: string, params: Readonly<Record<string, string>>): string {
  return path.replaceAll(/:([a-zA-Z0-9_]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`the path needs a "${name}" parameter`);
    return encodeURIComponent(value);
  });
}

interface CallArgs {
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | null | undefined>>;
  readonly signal?: AbortSignal;
}

/**
 * A field with no value is left out rather than sent as the word "undefined" or
 * "null" — which is what a cursor would become on the first page, and what the
 * server would then try to decode.
 */
function withQuery(
  path: string,
  query: Readonly<Record<string, string | number | null | undefined>> | undefined,
): string {
  if (query === undefined) return path;

  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) search.set(name, String(value));
  }
  const rendered = search.toString();

  return rendered === '' ? path : `${path}?${rendered}`;
}

function operation(endpoint: Endpoint): (args?: CallArgs) => Promise<unknown> {
  return async (args = {}) => {
    // An endpoint that declares a body gets one even when it is empty: the
    // server parses what the contract says it will receive, and sending nothing
    // to a route expecting JSON is a 400 rather than a smaller request.
    const body = args.body ?? (endpoint.body === undefined ? undefined : {});
    const payload = await apiFetch({
      method: endpoint.method,
      path: withQuery(fillPath(endpoint.path, args.params ?? {}), args.query),
      expect: endpoint.status,
      ...(body === undefined ? {} : { body }),
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    // Parsed, not trusted. Unknown fields are stripped rather than rejected, so
    // a server that adds one stays compatible with a client that has not shipped.
    return endpoint.response.parse(payload);
  };
}

/**
 * The one place a path or a verb is written. A renamed field or a wrong path is
 * a compile error here rather than a 404 in front of somebody.
 *
 * The factory lives in the web application, not in `@fca/contracts`: the API
 * imports those schemas too, and a browser fetch layer has no business being in
 * a package the server depends on.
 */
function createClient<T extends Record<string, Record<string, Endpoint>>>(contracts: T): Client<T> {
  const groups = Object.entries(contracts).map(([group, endpoints]) => [
    group,
    Object.fromEntries(
      Object.entries(endpoints).map(([name, endpoint]) => [name, operation(endpoint)]),
    ),
  ]);

  // The one assertion in this file. The runtime shape is built by walking the
  // contracts, which no signature can express; the mapped type above is what
  // callers see, and every call site is checked against it.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return Object.fromEntries(groups) as Client<T>;
}

export const api = createClient({ auth: authContract, conversations: conversationsContract });
