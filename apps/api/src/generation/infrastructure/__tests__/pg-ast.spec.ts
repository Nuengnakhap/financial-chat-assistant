import { describe, expect, it } from 'vitest';

import { inspect, isRecord, namePartsOf } from '../pg-ast';

/**
 * The walk, against trees the parser would not produce.
 *
 * Every one of these is a shape that cannot come out of libpg_query today, which
 * is exactly why they are here: what the walk does with an unfamiliar shape is
 * the difference between a policy that fails closed and one that skips a node it
 * did not recognise. The corpus in `pg-ast-sql-policy.spec.ts` covers the shapes
 * that do occur.
 */

const EVERYTHING_ALLOWED: ReadonlySet<string> = new Set([
  'RangeVar',
  'FuncCall',
  'ColumnRef',
  'SelectStmt',
  'typeName',
  'relname',
  'funcname',
  'fields',
  'names',
  'op',
  'ctename',
  'aliasname',
  'name',
  'String',
  'sval',
]);

describe('reading a name out of the tree', () => {
  it('reads the ordinary shape', () => {
    expect(namePartsOf([{ String: { sval: 'pg_catalog' } }, { String: { sval: 'abs' } }])).toEqual([
      'pg_catalog',
      'abs',
    ]);
  });

  it('reads a star as a star', () => {
    expect(namePartsOf([{ A_Star: {} }])).toEqual(['*']);
  });

  it('has no parts to read when the field is not a list', () => {
    expect(namePartsOf(undefined)).toEqual([]);
    expect(namePartsOf('revenue')).toEqual([]);
  });

  it.each([
    ['a part that is not an object', ['revenue']],
    ['a part with no String in it', [{ Integer: { ival: 1 } }]],
    ['a String with no text in it', [{ String: {} }]],
    ['a String whose text is a number', [{ String: { sval: 7 } }]],
  ])('turns %s into a name nothing allows', (_case, fields) => {
    // Not an empty list and not a skip: a name with a space in it, which no
    // allowlist holds — so an unreadable name is refused rather than ignored.
    expect(namePartsOf(fields)).toEqual(['unreadable name']);
  });
});

describe('what an object is', () => {
  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [[], false],
    [null, false],
    ['text', false],
    [7, false],
  ])('%j is an object: %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('walking a tree', () => {
  it('finds a table with no schema and one with', () => {
    const found = inspect(
      [
        { RangeVar: { relname: 'financial_data' } },
        { RangeVar: { relname: 'x', schemaname: 'y' } },
      ],
      EVERYTHING_ALLOWED,
    );

    expect(found.tables).toEqual([
      { name: 'financial_data', schema: null },
      { name: 'x', schema: 'y' },
    ]);
  });

  it('gives a table with no name one that nothing allows', () => {
    expect(inspect({ RangeVar: {} }, EVERYTHING_ALLOWED).tables).toEqual([
      { name: 'unreadable name', schema: null },
    ]);
  });

  it('treats a select with no operation as no set operation', () => {
    expect(inspect({ SelectStmt: {} }, EVERYTHING_ALLOWED).hasSetOperation).toBe(false);
    expect(inspect({ SelectStmt: { op: 'SETOP_UNION' } }, EVERYTHING_ALLOWED).hasSetOperation).toBe(
      true,
    );
  });

  it('reports every key the allowlist does not have, however deep', () => {
    const found = inspect(
      { SelectStmt: { whereClause: { Nonsense: { deeper: 1 } } } },
      EVERYTHING_ALLOWED,
    );

    expect(found.unknownKeys).toEqual(['whereClause', 'Nonsense', 'deeper']);
  });

  it('collects the names a query introduces, and not the operators', () => {
    const found = inspect(
      [
        { ResTarget: { name: 'total' } },
        { CommonTableExpr: { ctename: 'recent' } },
        { Alias: { aliasname: 'f' } },
        // An operator is a list under the same key, which is what separates it
        // from an alias.
        { A_Expr: { name: [{ String: { sval: '=' } }] } },
      ],
      EVERYTHING_ALLOWED,
    );

    expect([...found.resultNames]).toEqual(['total']);
    expect([...found.cteNames]).toEqual(['recent']);
    expect([...found.aliasNames]).toEqual(['f']);
  });

  it('finds nothing in a value that holds nothing', () => {
    for (const empty of [null, undefined, 'text', 7, []]) {
      expect(inspect(empty, EVERYTHING_ALLOWED).unknownKeys).toEqual([]);
    }
  });
});
