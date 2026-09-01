import { describe, expect, it } from 'vitest';

import { resultColumnsOf, usdNamesOf } from '../sql-units';

/**
 * The unit derivation, on trees written by hand.
 *
 * `pg-ast-sql-policy.spec.ts` asks the same questions through real SQL, which is
 * the reading that matters. What is here is the shapes real SQL cannot make: a
 * call with no arguments, a target with no value, a tree that is not a select.
 * Each of them is a way for the derivation to be asked something it has no
 * answer for, and the answer has to be "not money" rather than a crash.
 */

const column = (name: string): unknown => ({ ColumnRef: { fields: [{ String: { sval: name } }] } });
const target = (value: unknown, name?: string): unknown => ({
  ResTarget: { ...(name === undefined ? {} : { name }), val: value },
});
const select = (...targets: readonly unknown[]): unknown => ({ targetList: targets });

/** What the policy asks: the names, and which of them are amounts. */
const usdColumnsOf = (tree: unknown): ReadonlySet<string> => usdNamesOf(resultColumnsOf(tree));
const namesOf = (tree: unknown): readonly string[] =>
  resultColumnsOf(tree).map((column) => column.name);

describe('columns that hold amounts, from a tree', () => {
  it('finds nothing in something that is not a select', () => {
    for (const nonsense of [null, undefined, 'SELECT 1', 7, {}, { targetList: 'no' }]) {
      expect([...usdColumnsOf(nonsense)]).toEqual([]);
    }
  });

  it('finds nothing in a target with no value in it', () => {
    expect([...usdColumnsOf(select({ ResTarget: {} }, {}))]).toEqual([]);
  });

  it('reads a bare column', () => {
    expect([...usdColumnsOf(select(target(column('revenue'))))]).toEqual(['revenue']);
    expect([...usdColumnsOf(select(target(column('year'))))]).toEqual([]);
  });

  it('reads a qualified column by its last part', () => {
    const qualified = {
      ColumnRef: { fields: [{ String: { sval: 'f' } }, { String: { sval: 'revenue' } }] },
    };

    expect([...usdColumnsOf(select(target(qualified)))]).toEqual(['revenue']);
  });

  it('has no unit for a call with no arguments, whatever it is called', () => {
    // `sum()` is not valid SQL, so nothing real gets here — and the answer to a
    // shape with nothing in it is still "not an amount".
    const empty = { FuncCall: { funcname: [{ String: { sval: 'sum' } }] } };

    expect([...usdColumnsOf(select(target(empty)))]).toEqual([]);
  });

  it('has no unit for a call with no name', () => {
    const nameless = { FuncCall: { args: [column('revenue')] } };

    expect([...usdColumnsOf(select(target(nameless)))]).toEqual([]);
  });

  it('carries the unit through a cast and names the column after the value', () => {
    const cast = { TypeCast: { arg: column('net_income') } };

    expect([...usdColumnsOf(select(target(cast)))]).toEqual(['net_income']);
  });

  it('names a coalesce and a case the way PostgreSQL does', () => {
    const coalesce = { CoalesceExpr: { args: [column('revenue')] } };
    const branching = { CaseExpr: { args: [] } };

    expect([...usdColumnsOf(select(target(coalesce), target(branching)))]).toEqual(['coalesce']);
  });

  it('calls an expression it cannot name what PostgreSQL calls it', () => {
    const difference = {
      A_Expr: {
        name: [{ String: { sval: '-' } }],
        lexpr: column('revenue'),
        rexpr: column('net_income'),
      },
    };

    expect([...usdColumnsOf(select(target(difference)))]).toEqual(['?column?']);
  });

  it('does not carry the unit through multiplication or division', () => {
    for (const operator of ['*', '/', '%', '||']) {
      const applied = {
        A_Expr: {
          name: [{ String: { sval: operator } }],
          lexpr: column('revenue'),
          rexpr: column('revenue'),
        },
      };

      expect([...usdColumnsOf(select(target(applied, 'result')))]).toEqual([]);
    }
  });

  it('does not carry a unit through an operator it cannot read', () => {
    const applied = { A_Expr: { lexpr: column('revenue'), rexpr: column('revenue') } };

    expect([...usdColumnsOf(select(target(applied, 'result')))]).toEqual([]);
  });

  it('prefers the name the query declared', () => {
    expect([...usdColumnsOf(select(target(column('revenue'), 'takings')))]).toEqual(['takings']);
  });

  it('names every result column, amount or not', () => {
    // The policy reads this list to find two columns with one name, so a name it
    // fails to work out is a duplicate it fails to see.
    expect(namesOf(select(target(column('company')), target(column('revenue'))))).toEqual([
      'company',
      'revenue',
    ]);
  });
});

describe('a star', () => {
  const star = { ColumnRef: { fields: [{ A_Star: {} }] } };
  const from = (...names: readonly string[]): unknown[] =>
    names.map((relname) => ({ RangeVar: { relname } }));

  it('stands for the table when the table is what is being read', () => {
    const tree = { targetList: [target(star)], fromClause: from('financial_data') };

    expect(namesOf(tree)).toEqual([
      'company',
      'ticker',
      'sector',
      'year',
      'revenue',
      'net_income',
      'operating_income',
      'gross_profit',
    ]);
    expect([...usdColumnsOf(tree)].sort()).toEqual([
      'gross_profit',
      'net_income',
      'operating_income',
      'revenue',
    ]);
  });

  it('stands for both relations when two are being read, repeats and all', () => {
    // The repeats are the point. Returning nothing here reads as "there are no
    // columns" to the check for two columns with one name, which is how a star
    // hid a duplicate `revenue` and handed one column's figure to the other.
    const tree = {
      targetList: [target(star)],
      fromClause: from('financial_data', 'financial_data'),
    };

    const names = namesOf(tree);
    expect(names.length).toBe(16);
    expect(names.filter((name) => name === 'revenue').length).toBe(2);
  });

  it('reads a star qualified by an alias as that relation alone', () => {
    const tree = {
      targetList: [target({ ColumnRef: { fields: [{ String: { sval: 'a' } }, { A_Star: {} }] } })],
      fromClause: [
        { RangeVar: { relname: 'financial_data', alias: { aliasname: 'a' } } },
        { RangeVar: { relname: 'financial_data', alias: { aliasname: 'b' } } },
      ],
    };

    expect(namesOf(tree).length).toBe(8);
  });

  it('stands for nothing when the alias it names is not there', () => {
    const tree = {
      targetList: [target({ ColumnRef: { fields: [{ String: { sval: 'z' } }, { A_Star: {} }] } })],
      fromClause: from('financial_data'),
    };

    expect(namesOf(tree)).toEqual([]);
  });

  it('reads a star over a join through both of its sides', () => {
    const tree = {
      targetList: [target(star)],
      fromClause: [
        {
          JoinExpr: {
            larg: { RangeVar: { relname: 'financial_data' } },
            rarg: {
              RangeSubselect: {
                subquery: {
                  SelectStmt: {
                    targetList: [target(column('revenue'))],
                    fromClause: from('financial_data'),
                  },
                },
                alias: { aliasname: 't' },
              },
            },
          },
        },
      ],
    };

    expect(namesOf(tree).length).toBe(9);
    expect(namesOf(tree).filter((name) => name === 'revenue').length).toBe(2);
  });

  it('stands for nothing when the join has nothing readable in it', () => {
    const tree = { targetList: [target(star)], fromClause: [{ JoinExpr: {} }, 'not a relation'] };

    expect(namesOf(tree)).toEqual([]);
  });

  it.each([
    ['a target that is not an object', { targetList: ['nonsense'] }],
    [
      'a WITH entry that is not an object',
      { targetList: [target(star)], withClause: { ctes: ['x'] } },
    ],
    [
      'a subselect with no query in it',
      { targetList: [target(star)], fromClause: [{ RangeSubselect: {} }] },
    ],
    [
      'a FROM item that is no kind of relation',
      { targetList: [target(star)], fromClause: [{ Something: {} }] },
    ],
    [
      'a relation whose name is not a name',
      { targetList: [target(star)], fromClause: [{ RangeVar: { relname: 7 } }] },
    ],
    ['a column reference with no fields', { targetList: [target({ ColumnRef: { fields: [] } })] }],
  ])('finds no amounts in %s', (_case, tree) => {
    // None of these can come out of the parser. What they establish is that an
    // unfamiliar shape yields no display string rather than a guessed one.
    expect([...usdColumnsOf(tree)]).toEqual([]);
  });

  it('falls back to the relation name when the alias is not a name', () => {
    // The alias is only what a qualified star matches against; the columns come
    // from the relation either way.
    const tree = {
      targetList: [target(star)],
      fromClause: [{ RangeVar: { relname: 'financial_data', alias: { aliasname: 7 } } }],
    };

    expect([...usdColumnsOf(tree)].sort()).toEqual([
      'gross_profit',
      'net_income',
      'operating_income',
      'revenue',
    ]);
  });

  it('resolves a WITH that selects from an earlier WITH', () => {
    const cte = (name: string, inner: unknown): unknown => ({
      CommonTableExpr: { ctename: name, ctequery: { SelectStmt: inner } },
    });
    const tree = {
      targetList: [target(star)],
      fromClause: from('second'),
      withClause: {
        ctes: [
          cte('first', {
            targetList: [target(column('revenue'))],
            fromClause: from('financial_data'),
          }),
          cte('second', { targetList: [target(star)], fromClause: from('first') }),
        ],
      },
    };

    expect(namesOf(tree)).toEqual(['revenue']);
    expect([...usdColumnsOf(tree)]).toEqual(['revenue']);
  });

  it('stands for nothing when there is no FROM at all', () => {
    expect(namesOf({ targetList: [target(star)] })).toEqual([]);
  });

  it('stands for what a CTE selected, unit and all', () => {
    const tree = {
      targetList: [target(star)],
      fromClause: from('t'),
      withClause: {
        ctes: [
          {
            CommonTableExpr: {
              ctename: 't',
              ctequery: {
                SelectStmt: {
                  targetList: [
                    target(column('company')),
                    // A fiscal year wearing the name of an amount, which is the
                    // whole reason a star is resolved rather than assumed.
                    target(column('year'), 'revenue'),
                  ],
                  fromClause: from('financial_data'),
                },
              },
            },
          },
        ],
      },
    };

    expect(namesOf(tree)).toEqual(['company', 'revenue']);
    expect([...usdColumnsOf(tree)]).toEqual([]);
  });

  it('stands for nothing when the CTE is not one this query declared', () => {
    const tree = { targetList: [target(star)], fromClause: from('somewhere_else') };

    expect(namesOf(tree)).toEqual([]);
  });

  it('stands for nothing when the WITH clause is not one', () => {
    for (const withClause of [
      null,
      'WITH',
      { ctes: 'no' },
      { ctes: [{}, { CommonTableExpr: {} }] },
    ]) {
      expect(namesOf({ targetList: [target(star)], fromClause: from('t'), withClause })).toEqual(
        [],
      );
    }
  });
});
