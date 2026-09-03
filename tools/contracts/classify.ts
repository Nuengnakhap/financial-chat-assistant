import type { ContractSurface, Json, Role, SurfaceEntry } from './surface';

/**
 * What a difference between two recorded surfaces costs.
 *
 * The rules are the compatibility table in `CONTRIBUTING.md` turned into code.
 * Only the safe shapes
 * are recognised; **anything else is breaking**, which is the only default that
 * fails towards a person looking at it. A classifier that guesses "probably
 * fine" for a change it has not been taught is worse than no classifier, because
 * it is trusted.
 */

export type Verdict =
  /** Old clients and old servers both keep working. Merge it. */
  | 'additive'
  /** Nothing breaks, but the server has to be deployed before the client. */
  | 'deploy-ordered'
  /** Someone loses. Needs a deprecation, or a v2. */
  | 'breaking';

export interface Change {
  readonly verdict: Verdict;
  /** Down to the field: "the surface differs" is what `git diff` already says. */
  readonly path: string;
  readonly detail: string;
}

interface Pair {
  readonly before: Json;
  readonly after: Json;
}

const KEYWORDS_HANDLED_SEPARATELY = new Set(['properties', 'required', 'anyOf', 'oneOf', 'enum']);

const change = (verdict: Verdict, path: string, detail: string): Change => ({
  verdict,
  path,
  detail,
});

function isObject(value: Json | undefined): value is Readonly<Record<string, Json>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isList(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

function asList(value: Json | undefined): readonly Json[] {
  return isList(value) ? value : [];
}

function names(value: Json | undefined): readonly string[] {
  return isObject(value) ? Object.keys(value) : [];
}

const same = (a: Json | undefined, b: Json | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** A client that must now send something it does not know about is broken. */
const requiredAdded = (role: Role): Verdict => (role === 'request' ? 'breaking' : 'deploy-ordered');

/** A client that reads something the server stopped sending is broken. */
const fieldRemoved = (role: Role): Verdict => (role === 'response' ? 'breaking' : 'deploy-ordered');

function propertiesOf(node: Json): Json | undefined {
  return isObject(node) ? node['properties'] : undefined;
}

function addedProperties(path: string, role: Role, pair: Pair): Change[] {
  const before = names(propertiesOf(pair.before));
  const nowRequired = new Set(asList(isObject(pair.after) ? pair.after['required'] : undefined));

  return names(propertiesOf(pair.after))
    .filter((name) => !before.includes(name))
    .map((name) =>
      nowRequired.has(name)
        ? change(requiredAdded(role), `${path}.${name}`, 'a required property was added')
        : change('additive', `${path}.${name}`, 'an optional property was added'),
    );
}

function diffProperties(path: string, role: Role, pair: Pair): Change[] {
  const before = propertiesOf(pair.before);
  const after = propertiesOf(pair.after);
  const changes: Change[] = addedProperties(path, role, pair);

  for (const name of names(before)) {
    if (!names(after).includes(name)) {
      changes.push(change(fieldRemoved(role), `${path}.${name}`, 'a property was removed'));
      continue;
    }
    if (!isObject(before) || !isObject(after)) continue;
    const pairing = { before: before[name] ?? null, after: after[name] ?? null };
    changes.push(...diffNode(`${path}.${name}`, role, pairing));
  }

  return changes;
}

/** Only for properties that exist on both sides; new ones are reported above. */
function diffRequired(path: string, role: Role, pair: Pair): Change[] {
  const before = new Set(asList(isObject(pair.before) ? pair.before['required'] : undefined));
  const after = new Set(asList(isObject(pair.after) ? pair.after['required'] : undefined));
  const still = names(propertiesOf(pair.after));
  const known = names(propertiesOf(pair.before));
  const changes: Change[] = [];

  for (const name of known.filter((property) => still.includes(property))) {
    const was = before.has(name);
    const now = after.has(name);
    if (was === now) continue;

    changes.push(
      now
        ? change(requiredAdded(role), `${path}.${name}`, 'an optional property became required')
        : change(
            role === 'request' ? 'additive' : 'breaking',
            `${path}.${name}`,
            'a required property became optional',
          ),
    );
  }

  return changes;
}

/**
 * What a variant is called, when the union has a discriminator: the first
 * property pinned to a single literal. `type=text_delta` rather than "the third
 * one" — because the third one stops being the third one the moment somebody
 * inserts an event above it, and nothing about the wire changed when they did.
 */
function variantKey(variant: Json): string | null {
  if (!isObject(variant)) return null;

  const properties = variant['properties'];
  if (!isObject(properties)) return null;

  for (const name of Object.keys(properties).sort()) {
    const pinned = isObject(properties[name]) ? properties[name]['const'] : undefined;
    // Only a scalar names a variant. An object pinned by `const` would stringify
    // to `[object Object]`, which names every one of them the same thing.
    if (typeof pinned === 'string' || typeof pinned === 'number')
      return `${name}=${String(pinned)}`;
  }

  return null;
}

/** Null when the variants cannot all be named apart — a nullable, say. */
function byKey(variants: readonly Json[]): ReadonlyMap<string, Json> | null {
  const keyed = new Map<string, Json>();

  for (const variant of variants) {
    const key = variantKey(variant);
    if (key === null || keyed.has(key)) return null;
    keyed.set(key, variant);
  }

  return keyed;
}

interface Variants {
  readonly before: ReadonlyMap<string, Json>;
  readonly after: ReadonlyMap<string, Json>;
}

function diffKeyedVariants(path: string, role: Role, variants: Variants): Change[] {
  const changes: Change[] = [];

  for (const [key, variant] of variants.after) {
    const was = variants.before.get(key);
    if (was === undefined) {
      changes.push(change('additive', `${path}(${key})`, 'a variant was added'));
      continue;
    }
    changes.push(...diffNode(`${path}(${key})`, role, { before: was, after: variant }));
  }

  for (const key of variants.before.keys()) {
    if (!variants.after.has(key)) {
      changes.push(change('breaking', `${path}(${key})`, 'a variant was removed'));
    }
  }

  return changes;
}

function diffPositionalVariants(path: string, role: Role, pair: BothLists): Change[] {
  const changes: Change[] = [];

  for (const [index, variant] of pair.before.entries()) {
    const at = `${path}[${String(index)}]`;
    if (index >= pair.after.length) {
      changes.push(change('breaking', at, 'a variant was removed'));
      continue;
    }
    changes.push(...diffNode(at, role, { before: variant, after: pair.after[index] ?? null }));
  }

  for (let index = pair.before.length; index < pair.after.length; index += 1) {
    changes.push(change('additive', `${path}[${String(index)}]`, 'a variant was added'));
  }

  return changes;
}

interface BothLists {
  readonly before: readonly Json[];
  readonly after: readonly Json[];
}

/**
 * A union of variants, which is what a discriminated union of SSE events comes
 * out as. Adding one is the change the SSE contract guarantees is safe — a client that
 * does not know an event skips it — and it stays safe wherever in the list it
 * lands, so the variants are matched by their discriminator and only fall back
 * to position when there is not one.
 */
const UNION_KEYWORDS = ['anyOf', 'oneOf'] as const;

/** Which of the two spellings this node uses, or null when it is not a union. */
function unionKeyword(node: Json): (typeof UNION_KEYWORDS)[number] | null {
  if (!isObject(node)) return null;

  return UNION_KEYWORDS.find((keyword) => node[keyword] !== undefined) ?? null;
}

function diffVariants(path: string, role: Role, pair: Pair): Change[] {
  const was = unionKeyword(pair.before);
  const now = unionKeyword(pair.after);
  const lists: BothLists = {
    before: asList(was === null || !isObject(pair.before) ? undefined : pair.before[was]),
    after: asList(now === null || !isObject(pair.after) ? undefined : pair.after[now]),
  };

  // The two are not the same promise: `oneOf` says exactly one alternative
  // matches and `anyOf` says at least one does. Swapping them leaves every
  // variant in place, so matching by discriminator would report the change as
  // nothing at all — and this is the one keyword pair `diffKeywords` skips.
  const swapped =
    was !== null && now !== null && was !== now
      ? [change('breaking', path, `a union of \`${was}\` became one of \`${now}\``)]
      : [];

  const before = byKey(lists.before);
  const after = byKey(lists.after);
  if (before !== null && after !== null) {
    return [...swapped, ...diffKeyedVariants(path, role, { before, after })];
  }

  return [...swapped, ...diffPositionalVariants(path, role, lists)];
}

/**
 * A closed set of strings. Widening one is safe for whoever reads it and new
 * for whoever writes it, so which way it travels decides.
 */
function diffEnum(path: string, role: Role, pair: Pair): Change[] {
  const before = asList(isObject(pair.before) ? pair.before['enum'] : undefined).map(String);
  const after = asList(isObject(pair.after) ? pair.after['enum'] : undefined).map(String);
  const changes: Change[] = [];

  for (const value of after.filter((v) => !before.includes(v))) {
    const verdict = role === 'request' ? 'additive' : 'deploy-ordered';
    changes.push(change(verdict, `${path}(${value})`, 'a value was added to a closed set'));
  }

  for (const value of before.filter((v) => !after.includes(v))) {
    const verdict = role === 'request' ? 'breaking' : 'additive';
    changes.push(change(verdict, `${path}(${value})`, 'a value was removed from a closed set'));
  }

  return changes;
}

/**
 * Every keyword that is not one of the four above. A keyword appearing,
 * disappearing or changing is a constraint appearing, disappearing or changing —
 * `minLength`, `pattern`, `format`, `type` — and none of those is safe by
 * default. Nested objects (`items`, a property's own schema) recurse.
 */
function diffKeywords(path: string, role: Role, pair: Pair): Change[] {
  if (!isObject(pair.before) || !isObject(pair.after)) return [];

  const before = pair.before;
  const after = pair.after;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: Change[] = [];

  for (const key of [...keys].sort()) {
    if (KEYWORDS_HANDLED_SEPARATELY.has(key)) continue;

    const [was, now] = [before[key], after[key]];
    if (same(was, now)) continue;

    if (was !== undefined && now !== undefined && isObject(was) && isObject(now)) {
      changes.push(...diffNode(`${path}.${key}`, role, { before: was, after: now }));
      continue;
    }

    changes.push(change('breaking', `${path}.${key}`, describeKeyword(key, was, now)));
  }

  return changes;
}

function describeKeyword(key: string, was: Json | undefined, now: Json | undefined): string {
  if (was === undefined) return `\`${key}\` was added (${JSON.stringify(now)})`;
  if (now === undefined) return `\`${key}\` was removed`;

  return `\`${key}\` changed from ${JSON.stringify(was)} to ${JSON.stringify(now)}`;
}

function diffNode(path: string, role: Role, pair: Pair): Change[] {
  if (same(pair.before, pair.after)) return [];

  if (!isObject(pair.before) || !isObject(pair.after)) {
    return [change('breaking', path, describeKeyword('schema', pair.before, pair.after))];
  }

  return [
    ...diffProperties(path, role, pair),
    ...diffRequired(path, role, pair),
    ...diffVariants(path, role, pair),
    ...diffEnum(path, role, pair),
    ...diffKeywords(path, role, pair),
  ];
}

function diffEntry(path: string, before: SurfaceEntry, after: SurfaceEntry): Change[] {
  if (before.kind !== after.kind) {
    return [change('breaking', path, `a ${before.kind} became a ${after.kind}`)];
  }
  // Behaviour, not shape. That it is still exported is the whole of what was
  // recorded, and the line above is what checks it.
  if (before.kind === 'function') return [];
  if (before.kind === 'value' && after.kind === 'value') {
    return same(before.value, after.value)
      ? []
      : [change('breaking', path, describeKeyword('value', before.value, after.value))];
  }
  if (before.kind !== 'schema' || after.kind !== 'schema') return [];
  if (before.role !== after.role) {
    return [
      change('breaking', path, `it travelled as a ${before.role} and now as a ${after.role}`),
    ];
  }

  return diffNode(path, after.role, { before: before.schema, after: after.schema });
}

export function classify(before: ContractSurface, after: ContractSurface): readonly Change[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: Change[] = [];

  for (const path of paths) {
    const was = before[path];
    const now = after[path];

    if (was === undefined && now !== undefined) {
      changes.push(change('additive', path, 'it was added to the published surface'));
    } else if (was !== undefined && now === undefined) {
      changes.push(change('breaking', path, 'it was removed from the published surface'));
    } else if (was !== undefined && now !== undefined) {
      changes.push(...diffEntry(path, was, now));
    }
  }

  return changes;
}
