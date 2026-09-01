import { FINANCIAL_DATA_COLUMNS, FINANCIAL_DATA_TABLE } from './financial-data.table';
import { isRecord, namePartsOf } from './pg-ast';

/**
 * What the result columns are called and which of them hold amounts in USD, read
 * off the query rather than off the result.
 *
 * The alternative — matching the column names the driver hands back against the
 * table's money columns — fails on the most ordinary query there is:
 * `SELECT company, sum(revenue) …` comes back with a column called `sum`, and a
 * name is not a unit. Getting this wrong is not cosmetic. A display string is
 * what the model copies instead of formatting a figure itself, so a missing one
 * costs a draft, and a wrong one is worse than either: evidence is matched by
 * value across every column, so `$2.0K` printed against the fiscal year 2024
 * finds support in the year column and the answer passes verification while
 * being wrong. Anywhere the unit cannot be established, there is no display
 * string.
 *
 * Only addition and subtraction carry the unit across. `revenue / 1e9` is a
 * number of billions and `$25.8` would be a lie about it.
 */

type Unit = 'usd' | 'other';

export interface ResultColumn {
  /** The name PostgreSQL will give it, which is how a result is matched back. */
  readonly name: string;
  readonly unit: Unit;
}

/** Functions that return their first argument's unit. `count` is not one of them. */
const UNIT_PRESERVING: ReadonlySet<string> = new Set([
  'sum',
  'avg',
  'min',
  'max',
  'round',
  'abs',
  'lag',
  'lead',
]);

const ADDITIVE: ReadonlySet<string> = new Set(['+', '-']);

/** What PostgreSQL calls a result column it cannot name. */
const ANONYMOUS = '?column?';

export function resultColumnsOf(select: unknown): readonly ResultColumn[] {
  return columnsOfSelect(select, new Map());
}

export function usdNamesOf(columns: readonly ResultColumn[]): ReadonlySet<string> {
  return new Set(columns.filter((column) => column.unit === 'usd').map((column) => column.name));
}

type Scope = ReadonlyMap<string, readonly ResultColumn[]>;

interface Query {
  readonly select: unknown;
  /** What every `WITH` name in scope stands for, the outer ones included. */
  readonly scope: Scope;
}

function columnsOfSelect(select: unknown, inherited: Scope): readonly ResultColumn[] {
  // The query and what its `WITH` names stand for travel together, because a
  // star can only be read with both in hand.
  const query: Query = { select, scope: commonTableScope(select, inherited) };

  return targetsOf(select).flatMap((wrapper) => {
    const target = isRecord(wrapper) ? wrapper['ResTarget'] : null;
    return columnsOf(query, target);
  });
}

/**
 * What each `WITH` name stands for, so `SELECT * FROM t` is read as the columns
 * `t` selected rather than as the columns of the table underneath it. Without
 * this, `WITH t AS (SELECT year AS revenue …) SELECT * FROM t` would put a fiscal
 * year in a column called `revenue` and give it a display string of `$2.0K`.
 *
 * Built up as it goes, which is also what PostgreSQL does: a `WITH` may select
 * from the ones declared before it, and each is resolved against those.
 */
function commonTableScope(select: unknown, inherited: Scope): Scope {
  const withClause = isRecord(select) ? select['withClause'] : null;
  const ctes = isRecord(withClause) ? withClause['ctes'] : null;
  if (!Array.isArray(ctes)) return inherited;

  const scope = new Map(inherited);
  for (const wrapper of ctes) {
    const cte = isRecord(wrapper) ? wrapper['CommonTableExpr'] : null;
    if (!isRecord(cte)) continue;

    const name = cte['ctename'];
    const query = isRecord(cte['ctequery']) ? cte['ctequery']['SelectStmt'] : null;
    if (typeof name === 'string') scope.set(name, columnsOfSelect(query, scope));
  }

  return scope;
}

function targetsOf(select: unknown): readonly unknown[] {
  if (!isRecord(select)) return [];
  const targets = select['targetList'];
  return Array.isArray(targets) ? targets : [];
}

/** One entry per result column, which is more than one when the target is `*`. */
function columnsOf(query: Query, target: unknown): readonly ResultColumn[] {
  const value = isRecord(target) ? target['val'] : null;
  const star = starFields(value);
  if (star !== null) return starColumns(query, star);

  const declared = isRecord(target) ? target['name'] : null;
  const name = typeof declared === 'string' ? declared : nameOf(value);
  return [{ name, unit: unitOf(value) }];
}

/**
 * What `*` stands for, which is whatever the query selects from — resolved,
 * never assumed.
 *
 * Both halves of a join are resolved rather than given up on, because giving up
 * returned *no* columns, and no columns reads as "there is nothing here" to
 * whoever is checking for two columns with one name. That is how
 * `SELECT a.*, b.revenue FROM financial_data a JOIN financial_data b …` came back
 * with two columns called `revenue` — the second, last year's figure, silently
 * becoming the display string for the first.
 */
function starColumns(query: Query, fields: readonly string[]): readonly ResultColumn[] {
  const from = isRecord(query.select) ? query.select['fromClause'] : null;
  const items: readonly unknown[] = Array.isArray(from) ? from : [];
  const relations = items.flatMap((item) => relationsOf(item, query.scope));

  const qualifier = fields.length > 1 ? fields[0] : undefined;
  if (qualifier === undefined) return relations.flatMap((relation) => relation.columns);

  return relations.find((relation) => relation.name === qualifier)?.columns ?? [];
}

interface Relation {
  /** What a qualified star has to match: an alias if there is one, else the name. */
  readonly name: string | null;
  readonly columns: readonly ResultColumn[];
}

function relationsOf(item: unknown, scope: Scope): readonly Relation[] {
  if (!isRecord(item)) return [];

  const rangeVar = item['RangeVar'];
  if (isRecord(rangeVar)) return [namedRelation(rangeVar, scope)];

  const subselect = item['RangeSubselect'];
  if (isRecord(subselect)) {
    const subquery = isRecord(subselect['subquery']) ? subselect['subquery']['SelectStmt'] : null;
    return [{ name: aliasOf(subselect), columns: columnsOfSelect(subquery, scope) }];
  }

  const join = item['JoinExpr'];
  if (!isRecord(join)) return [];
  return [...relationsOf(join['larg'], scope), ...relationsOf(join['rarg'], scope)];
}

function namedRelation(rangeVar: Readonly<Record<string, unknown>>, scope: Scope): Relation {
  const relname = rangeVar['relname'];
  const columns =
    relname === FINANCIAL_DATA_TABLE
      ? tableColumns()
      : ((typeof relname === 'string' ? scope.get(relname) : undefined) ?? []);

  return { name: aliasOf(rangeVar) ?? (typeof relname === 'string' ? relname : null), columns };
}

function aliasOf(node: Readonly<Record<string, unknown>>): string | null {
  const alias = node['alias'];
  const name = isRecord(alias) ? alias['aliasname'] : null;
  return typeof name === 'string' ? name : null;
}

function tableColumns(): readonly ResultColumn[] {
  return [...FINANCIAL_DATA_COLUMNS].map(([name, unit]) => ({
    name,
    unit: unit === 'usd' ? 'usd' : 'other',
  }));
}

/** The fields of a `*` target — `['a', '*']` for `a.*` — or `null` for anything else. */
function starFields(value: unknown): readonly string[] | null {
  const ref = isRecord(value) ? value['ColumnRef'] : null;
  const fields = isRecord(ref) ? namePartsOf(ref['fields']) : [];
  return fields.at(-1) === '*' ? fields : null;
}

function nameOf(value: unknown): string {
  if (!isRecord(value)) return ANONYMOUS;

  const columnRef = value['ColumnRef'];
  if (isRecord(columnRef)) return namePartsOf(columnRef['fields']).at(-1) ?? ANONYMOUS;

  const call = value['FuncCall'];
  if (isRecord(call)) return namePartsOf(call['funcname']).at(-1) ?? ANONYMOUS;

  const cast = value['TypeCast'];
  if (isRecord(cast)) return nameOf(cast['arg']);

  if ('CoalesceExpr' in value) return 'coalesce';
  if ('CaseExpr' in value) return 'case';
  return ANONYMOUS;
}

function unitOf(value: unknown): Unit {
  if (!isRecord(value)) return 'other';

  const columnRef = value['ColumnRef'];
  if (isRecord(columnRef)) {
    const column = namePartsOf(columnRef['fields']).at(-1) ?? '';
    return FINANCIAL_DATA_COLUMNS.get(column) === 'usd' ? 'usd' : 'other';
  }

  const call = value['FuncCall'];
  if (isRecord(call)) return callUnit(call);

  const cast = value['TypeCast'];
  if (isRecord(cast)) return unitOf(cast['arg']);

  const coalesce = value['CoalesceExpr'];
  if (isRecord(coalesce)) return unitOf(firstArg(coalesce));

  const expression = value['A_Expr'];
  return isRecord(expression) ? expressionUnit(expression) : 'other';
}

function callUnit(call: Readonly<Record<string, unknown>>): Unit {
  const name = namePartsOf(call['funcname']).at(-1) ?? '';
  return UNIT_PRESERVING.has(name) ? unitOf(firstArg(call)) : 'other';
}

/**
 * `revenue - net_income` is money and so is `revenue - 1`; one side being an
 * amount is enough. Multiplying or dividing two amounts is not an amount, which
 * is why only `+` and `-` are here.
 */
function expressionUnit(expression: Readonly<Record<string, unknown>>): Unit {
  const operator = namePartsOf(expression['name']).at(-1) ?? '';
  if (!ADDITIVE.has(operator)) return 'other';

  return unitOf(expression['lexpr']) === 'usd' || unitOf(expression['rexpr']) === 'usd'
    ? 'usd'
    : 'other';
}

function firstArg(node: Readonly<Record<string, unknown>>): unknown {
  const args = node['args'];
  return Array.isArray(args) ? args[0] : null;
}
