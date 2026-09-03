import { describe, expect, it } from 'vitest';

import { classify, type Change, type Verdict } from '../classify';
import type { ContractSurface, Json, Role, SurfaceEntry } from '../surface';

/**
 * The compatibility rules in `CONTRIBUTING.md`, one case each. Every one of
 * these is a change someone
 * will make one day, and the verdict is what they will be told when they do.
 */

const object = (properties: Record<string, Json>, required: readonly string[] = []): Json => ({
  type: 'object',
  properties,
  required,
});

const text: Json = { type: 'string' };

const schema = (role: Role, body: Json): SurfaceEntry => ({ kind: 'schema', role, schema: body });

const surface = (entries: Record<string, SurfaceEntry>): ContractSurface => entries;

const one = (before: SurfaceEntry, after: SurfaceEntry): Change => {
  const changes = classify(surface({ target: before }), surface({ target: after }));
  expect(changes).toHaveLength(1);
  const [only] = changes;
  if (only === undefined) throw new Error('unreachable: length was asserted');

  return only;
};

const verdictOf = (before: SurfaceEntry, after: SurfaceEntry): Verdict =>
  one(before, after).verdict;

describe('a property that appears', () => {
  it('is additive when nothing has to send it', () => {
    const before = schema('response', object({ a: text }, ['a']));
    const after = schema('response', object({ a: text, b: text }, ['a']));

    expect(one(before, after)).toMatchObject({ verdict: 'additive', path: 'target.b' });
  });

  it('only orders a deploy when a response must now carry it', () => {
    // Nothing breaks: a client parsing non-strictly reads what it knows. But an
    // older server does not send it, so the server goes out first.
    const before = schema('response', object({ a: text }, ['a']));
    const after = schema('response', object({ a: text, b: text }, ['a', 'b']));

    expect(one(before, after)).toMatchObject({ verdict: 'deploy-ordered', path: 'target.b' });
  });

  it('breaks when a request must now carry it', () => {
    // Every client in the wild is now sending an incomplete body.
    const before = schema('request', object({ a: text }, ['a']));
    const after = schema('request', object({ a: text, b: text }, ['a', 'b']));

    expect(one(before, after)).toMatchObject({ verdict: 'breaking', path: 'target.b' });
  });
});

describe('a property that disappears', () => {
  it('breaks a response, and says which field it was', () => {
    const before = schema('response', object({ spent: text, remaining: text }, ['spent']));
    const after = schema('response', object({ spent: text }, ['spent']));

    expect(one(before, after)).toEqual({
      verdict: 'breaking',
      path: 'target.remaining',
      detail: 'a property was removed',
    });
  });

  it('is reported once, not twice, when it was a required one', () => {
    // The `required` list loses an entry at the same moment. Saying so as well
    // is true and useless: two lines about one field train people to skim.
    const before = schema('response', object({ a: text, b: text }, ['a', 'b']));
    const after = schema('response', object({ a: text }, ['a']));

    expect(classify(surface({ target: before }), surface({ target: after }))).toHaveLength(1);
  });
});

describe('a property that changes how required it is', () => {
  it('breaks a request when it becomes required', () => {
    const before = schema('request', object({ a: text }));
    const after = schema('request', object({ a: text }, ['a']));

    expect(verdictOf(before, after)).toBe('breaking');
  });

  it('breaks a response when it stops being required', () => {
    // The client reads it without checking, because the contract said it was there.
    const before = schema('response', object({ a: text }, ['a']));
    const after = schema('response', object({ a: text }));

    expect(verdictOf(before, after)).toBe('breaking');
  });

  it('relaxes a request safely', () => {
    const before = schema('request', object({ a: text }, ['a']));
    const after = schema('request', object({ a: text }));

    expect(verdictOf(before, after)).toBe('additive');
  });
});

describe('a discriminated union, which is what an SSE event is', () => {
  const events = (...types: string[]): Json => ({
    anyOf: types.map((type) => object({ type: { const: type }, at: text }, ['type'])),
  });

  it('may gain one — that is the SSE guarantee', () => {
    const before = schema('response', events('text_delta', 'usage'));
    const after = schema('response', events('text_delta', 'usage', 'tool_progress'));

    expect(one(before, after)).toMatchObject({
      verdict: 'additive',
      path: 'target(type=tool_progress)',
    });
  });

  it('may gain one anywhere in the list, because a wire has no third position', () => {
    // The variants are matched by discriminator. Matching by index instead
    // reports seven breaking changes for a change that altered nothing: every
    // event below the insertion is compared against its neighbour.
    const before = schema('response', events('text_delta', 'usage'));
    const after = schema('response', events('text_delta', 'tool_progress', 'usage'));

    expect(classify(surface({ target: before }), surface({ target: after }))).toEqual([
      { verdict: 'additive', path: 'target(type=tool_progress)', detail: 'a variant was added' },
    ]);
  });

  it('may not lose one, and is told which', () => {
    const before = schema('response', events('text_delta', 'usage'));
    const after = schema('response', events('text_delta'));

    expect(one(before, after)).toEqual({
      verdict: 'breaking',
      path: 'target(type=usage)',
      detail: 'a variant was removed',
    });
  });

  it('still compares what is inside a variant that stayed', () => {
    const before = schema('response', {
      anyOf: [object({ type: { const: 'usage' }, cost: text }, ['type', 'cost'])],
    });
    const after = schema('response', { anyOf: [object({ type: { const: 'usage' } }, ['type'])] });

    expect(one(before, after)).toMatchObject({ path: 'target(type=usage).cost' });
  });
});

describe('the two spellings of a union', () => {
  it('are not interchangeable, even with every variant left in place', () => {
    // `oneOf` says exactly one alternative matches; `anyOf` says at least one
    // does. Matching variants by discriminator finds nothing moved, so without
    // this the swap is reported as a list of additions — or as nothing.
    const variants = [object({ t: { const: 'a' } })];

    expect(
      one(schema('response', { oneOf: variants }), schema('response', { anyOf: variants })),
    ).toEqual({
      verdict: 'breaking',
      path: 'target',
      detail: 'a union of `oneOf` became one of `anyOf`',
    });
  });

  it('still compares the variants after saying the container moved', () => {
    const changes = classify(
      surface({ target: schema('response', { oneOf: [object({ t: { const: 'a' } })] }) }),
      surface({ target: schema('response', { anyOf: [object({ t: { const: 'b' } })] }) }),
    );

    expect(changes.map((change) => change.verdict)).toEqual(['breaking', 'additive', 'breaking']);
  });
});

describe('a union with nothing to tell its variants apart', () => {
  // `z.string().nullable()` comes out as `anyOf: [string, null]`. There is no
  // discriminator to match on, so position is all there is.
  const nullableText: Json = { anyOf: [text, { type: 'null' }] };

  it('falls back to position, and appending is still additive', () => {
    const after: Json = { anyOf: [text, { type: 'null' }, { type: 'number' }] };

    expect(one(schema('response', nullableText), schema('response', after))).toMatchObject({
      verdict: 'additive',
      path: 'target[2]',
    });
  });

  it('calls a lost alternative breaking', () => {
    expect(verdictOf(schema('response', nullableText), schema('response', { anyOf: [text] }))).toBe(
      'breaking',
    );
  });
});

describe('a closed set of values', () => {
  const values = (...list: string[]): Json => ({ type: 'string', enum: list });

  it('orders a deploy when a response can now say something new', () => {
    const before = schema('response', values('pending', 'complete'));
    const after = schema('response', values('pending', 'complete', 'stopped'));

    expect(one(before, after)).toMatchObject({
      verdict: 'deploy-ordered',
      path: 'target(stopped)',
    });
  });

  it('is safe to widen on the way in, and breaking to narrow', () => {
    const two = schema('request', values('a', 'b'));
    const three = schema('request', values('a', 'b', 'c'));

    expect(verdictOf(two, three)).toBe('additive');
    expect(verdictOf(three, two)).toBe('breaking');
  });
});

describe('anything the classifier has not been taught', () => {
  it('is breaking, because a tightened bound is not visibly different from a loosened one', () => {
    const before = schema('request', object({ a: { type: 'string', maxLength: 200 } }));
    const after = schema('request', object({ a: { type: 'string', maxLength: 50 } }));

    expect(one(before, after)).toMatchObject({
      verdict: 'breaking',
      path: 'target.a.maxLength',
      detail: '`maxLength` changed from 200 to 50',
    });
  });

  it('reaches inside an array to find it', () => {
    const before = schema('response', { type: 'array', items: object({ a: text }, ['a']) });
    const after = schema('response', { type: 'array', items: object({}, []) });

    expect(one(before, after)).toMatchObject({ verdict: 'breaking', path: 'target.items.a' });
  });

  it('counts a changed type as breaking rather than as two unrelated keywords', () => {
    expect(verdictOf(schema('response', text), schema('response', { type: 'number' }))).toBe(
      'breaking',
    );
  });
});

describe('the surface itself', () => {
  it('reports nothing when nothing moved', () => {
    const both = surface({ a: schema('response', object({ x: text })), b: { kind: 'function' } });

    expect(classify(both, both)).toEqual([]);
  });

  it('treats a new export as additive and a lost one as breaking', () => {
    const before = surface({ kept: { kind: 'function' }, lost: { kind: 'function' } });
    const after = surface({ kept: { kind: 'function' }, found: { kind: 'function' } });

    expect(classify(before, after)).toEqual([
      { verdict: 'additive', path: 'found', detail: 'it was added to the published surface' },
      { verdict: 'breaking', path: 'lost', detail: 'it was removed from the published surface' },
    ]);
  });

  it('breaks when a path or a status moves', () => {
    const before = surface({ 'c.get.status': { kind: 'value', value: 201 } });
    const after = surface({ 'c.get.status': { kind: 'value', value: 200 } });

    expect(classify(before, after)).toEqual([
      { verdict: 'breaking', path: 'c.get.status', detail: '`value` changed from 201 to 200' },
    ]);
  });

  it('breaks when a schema starts travelling the other way', () => {
    // Same shape, opposite direction: everything the classifier decides after
    // this point would be decided by the wrong half of the table.
    const before = schema('response', object({ a: text }));
    const after = schema('request', object({ a: text }));

    expect(one(before, after)).toMatchObject({ verdict: 'breaking' });
  });

  it('breaks when a schema becomes something that is not one', () => {
    expect(verdictOf(schema('response', text), { kind: 'function' })).toBe('breaking');
  });
});
