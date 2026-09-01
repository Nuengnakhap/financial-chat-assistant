/**
 * What a query written by the model may be made of — as an allowlist, and every
 * entry of it measured rather than remembered.
 *
 * A denylist of dangerous nodes was the obvious design and is the wrong one.
 * PostgreSQL 18 has several hundred parse-node types; a list of the bad ones is
 * a list of the ones somebody thought of, and `SELECT * INTO t2 FROM x` settles
 * the argument on its own: it arrives as an `intoClause` **field** on the
 * select, with no node type of its own to deny. Nothing that walked a list of
 * forbidden node types would see it.
 *
 * So the check is inverted. Every key the parser puts in the tree — node type
 * and field name alike, since the two are not distinguishable without a schema —
 * must appear below, and anything else is refused with the query. That makes the
 * question "is this construct one we have considered?" rather than "is this
 * construct one we have banned?", and the answer for `intoClause`,
 * `lockingClause`, `windowClause`, `valuesLists`, `typmods`, `indirection` and
 * everything else nobody has thought of yet is no.
 *
 * The set below is exactly what the accept corpus in
 * `__tests__/pg-ast-sql-policy.spec.ts` produces, and a test in that file fails
 * if an entry here is not needed by some query in it. A permission with no query
 * behind it is a permission nobody has looked at.
 */

/** A query longer than this is not a question about revenue; it also bounds AST depth. */
export const MAX_SQL_LENGTH = 4_000;

/**
 * The row ceiling, written into the query itself. Fifty rows of eight columns is
 * around 2,500 tokens; two hundred — the older figure, which appears in a
 * comment in `packages/grounding` this phase corrects — is ten thousand tokens
 * per tool call, paid for on every draft and again on every repair.
 */
export const MAX_ROWS = 50;

export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  // Statement envelope.
  'version',
  'stmts',
  'stmt',
  'stmt_len',
  // Select.
  'SelectStmt',
  'targetList',
  'distinctClause',
  'fromClause',
  'whereClause',
  'groupClause',
  'havingClause',
  'sortClause',
  'limitCount',
  'limitOffset',
  'limitOption',
  'withClause',
  'op',
  // Common table expressions.
  'CommonTableExpr',
  'ctes',
  'ctename',
  'ctequery',
  'ctematerialized',
  // Result columns.
  'ResTarget',
  'val',
  'name',
  'ColumnRef',
  'fields',
  'A_Star',
  // Relations.
  'RangeVar',
  'relname',
  'schemaname',
  'inh',
  'relpersistence',
  'alias',
  'aliasname',
  'RangeSubselect',
  'subquery',
  'JoinExpr',
  'jointype',
  'quals',
  'larg',
  'rarg',
  // Literals. A_Const holds its payload unwrapped: `{ ival: { ival: 10 } }`.
  'A_Const',
  'ival',
  'fval',
  'sval',
  'boolval',
  'isnull',
  'String',
  // Expressions.
  'A_Expr',
  'kind',
  'lexpr',
  'rexpr',
  'rexpr_list_start',
  'rexpr_list_end',
  'BoolExpr',
  'boolop',
  'NullTest',
  'arg',
  'nulltesttype',
  'CaseExpr',
  'CaseWhen',
  'expr',
  'result',
  'defresult',
  'CoalesceExpr',
  'List',
  'items',
  'TypeCast',
  'typeName',
  'names',
  'typemod',
  'SubLink',
  'subselect',
  'subLinkType',
  // Calls and windows. `over` holds a window definition with no wrapper of its own.
  'FuncCall',
  'funcname',
  'args',
  'agg_star',
  'agg_distinct',
  'funcformat',
  'over',
  'partitionClause',
  'orderClause',
  'frameOptions',
  // Sorting.
  'SortBy',
  'node',
  'sortby_dir',
  'sortby_nulls',
  // Present on every node the parser emits.
  'location',
]);

/**
 * `coalesce` and `nullif` are absent on purpose and still work: the parser turns
 * them into a `CoalesceExpr` and an `A_Expr` of kind `AEXPR_NULLIF`, so they are
 * allowed as structure and never reach this list. Listing them anyway would read
 * as though something depended on it.
 *
 * `upper` and `lower` are here and not in the plan's list. A model comparing a
 * company name case-insensitively is doing something reasonable, and the cost of
 * refusing it is a whole extra draft.
 */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'round',
  'abs',
  'rank',
  'dense_rank',
  'row_number',
  'lag',
  'lead',
  'upper',
  'lower',
]);

/**
 * Casts are allowed, so the type named in one has to be allowed too — otherwise
 * `'financial_data'::regclass` reads the catalog through a construct the node
 * allowlist has already accepted. The parser writes most of these qualified as
 * `pg_catalog.numeric` and a few, `text` among them, bare.
 */
export const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'numeric',
  'decimal',
  'int2',
  'int4',
  'int8',
  'float4',
  'float8',
  'text',
  'varchar',
]);
