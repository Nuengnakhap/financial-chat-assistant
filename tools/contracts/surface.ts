import { z } from 'zod';

import * as contracts from '@fca/contracts';

/**
 * The published shape of this package, as JSON.
 *
 * Everything the package exports is here, so nothing is in the contract by
 * being remembered: a schema that stops being exported disappears from this
 * map, and one that starts being exported appears in it without anyone
 * registering it anywhere. That is the whole point — a hand-written list of
 * "things to snapshot" is a list somebody eventually forgets to add to, and the
 * field it forgets is the field that changes unnoticed.
 *
 * Read with `classify` next door, which says which differences are safe.
 */

export type Json =
  string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };

/**
 * Which way the value travels, because the same change is not the same risk in
 * both directions: a newly required field is something a client must now send
 * (breaking) or something a server must now send (an ordering constraint).
 */
export type Role = 'request' | 'response';

export type SurfaceEntry =
  | { readonly kind: 'schema'; readonly role: Role; readonly schema: Json }
  | { readonly kind: 'value'; readonly value: Json }
  /** Behaviour, not shape. Recorded so that deleting one is still a change. */
  | { readonly kind: 'function' };

export type ContractSurface = Readonly<Record<string, SurfaceEntry>>;

/** Where a schema sits in an operation decides which way it travels. */
const REQUEST_SLOTS = ['body', 'query'] as const;

function isSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `$schema` says only which dialect the generator speaks. It repeats on every
 * one of the thirty-odd schemas and changes when zod does, which would make a
 * dependency bump look like a contract change.
 */
function jsonSchemaOf(schema: z.ZodType, role: Role): Json {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    io: role === 'request' ? 'input' : 'output',
  });

  return sortDeep(rest);
}

/**
 * Anything a contract can be made of that is not an object or an array. A
 * `bigint`, a symbol or an `undefined` reaching here is not a leaf this can
 * record, and recording it as something else would leave a piece of the
 * published surface unwatched — so it stops instead.
 */
function leaf(value: unknown): Json {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  throw new TypeError(`A contract exported a ${typeof value}, which has no place in JSON.`);
}

/** Key order is not part of a contract; sorting keeps a diff to what changed. */
function sortDeep(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isPlainObject(value)) return leaf(value);

  const sorted: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortDeep(value[key]);

  return sorted;
}

/**
 * Every schema an operation names as something the client sends. Collected by
 * identity rather than by the name it is exported under, so `startGenerationBody`
 * is a request because an operation takes it as a body — not because it ends in
 * the word "Body".
 */
function requestSchemas(): ReadonlySet<z.ZodType> {
  const found = new Set<z.ZodType>();

  for (const exported of Object.values(contracts)) {
    if (!isPlainObject(exported)) continue;
    for (const operation of Object.values(exported)) collectRequestSlots(operation, found);
  }

  return found;
}

function collectRequestSlots(operation: unknown, into: Set<z.ZodType>): void {
  if (!isPlainObject(operation)) return;

  for (const slot of REQUEST_SLOTS) {
    const schema = operation[slot];
    if (isSchema(schema)) into.add(schema);
  }
}

function roleOf(schema: z.ZodType, requests: ReadonlySet<z.ZodType>): Role {
  return requests.has(schema) ? 'request' : 'response';
}

/**
 * Flattened to one entry per leaf: `authContract.register.status` is its own
 * line, so a 201 that becomes a 200 is a change with a name rather than a diff
 * inside a blob.
 */
function flatten(
  path: string,
  value: unknown,
  requests: ReadonlySet<z.ZodType>,
): Record<string, SurfaceEntry> {
  if (isSchema(value)) {
    const role = roleOf(value, requests);

    return { [path]: { kind: 'schema', role, schema: jsonSchemaOf(value, role) } };
  }

  if (typeof value === 'function') return { [path]: { kind: 'function' } };

  if (isPlainObject(value)) {
    return Object.entries(value).reduce<Record<string, SurfaceEntry>>(
      (entries, [key, nested]) =>
        Object.assign(entries, flatten(`${path}.${key}`, nested, requests)),
      {},
    );
  }

  return { [path]: { kind: 'value', value: sortDeep(value) } };
}

/** Artefacts of the CommonJS build, not things the package publishes. */
const NOT_PUBLISHED = new Set(['__esModule', 'default']);

export function buildSurface(): ContractSurface {
  const requests = requestSchemas();
  const surface: Record<string, SurfaceEntry> = {};

  for (const name of Object.keys(contracts).sort()) {
    if (NOT_PUBLISHED.has(name)) continue;
    Object.assign(surface, flatten(name, Reflect.get(contracts, name), requests));
  }

  return surface;
}

/** Stable text, so the committed file changes only when the contract does. */
export function serialiseSurface(surface: ContractSurface): string {
  const ordered: Record<string, SurfaceEntry> = {};
  for (const key of Object.keys(surface).sort()) {
    const entry = surface[key];
    if (entry !== undefined) ordered[key] = entry;
  }

  return `${JSON.stringify(ordered, null, 2)}\n`;
}
