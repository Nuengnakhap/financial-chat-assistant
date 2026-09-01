import type { parseSync } from 'pgsql-parser';

/**
 * Reading a PostgreSQL parse tree, and the one walk that visits all of it.
 *
 * The tree is JSON — libpg_query returns a protobuf message rendered into plain
 * objects — so it is read as JSON here, with a type guard rather than the
 * generated interfaces. Those declare every field optional, which makes walking
 * them a chain of checks that says nothing, and none of them can express the
 * thing this file actually needs: *every* key, including the ones no interface
 * mentions. The generated types are used where a field is written instead, which
 * is the one place a wrong shape would matter.
 *
 * Deliberately one pass. A pass per rule reads better and lets one rule quietly
 * disagree with another about where it looked.
 */

/**
 * Derived from the parser's own return type rather than imported from
 * `@pgsql/types`, which is a dependency of the parser and not of this
 * application: naming it here would be a package this file uses without
 * declaring, and one free to drift out of step with the parser it came from.
 */
type ParsedSql = ReturnType<typeof parseSync>;
type RawStatement = NonNullable<ParsedSql['stmts']>[number];
type AstNode = NonNullable<RawStatement['stmt']>;
export type SelectStatement = Extract<AstNode, { SelectStmt: unknown }>['SelectStmt'];

/** Cannot be a table, column, function or type: none of them are spelled with a space. */
const UNREADABLE_NAME = 'unreadable name';

interface TableReference {
  readonly name: string;
  readonly schema: string | null;
}

/** What one walk of the tree found. Judging it is `sql-checks.ts`'s job. */
export interface Inspection {
  /** Keys the allowlist does not have. Anything here refuses the query. */
  readonly unknownKeys: readonly string[];
  readonly tables: readonly TableReference[];
  /** Each entry is the parts of one name, so `pg_catalog.abs` stays two parts. */
  readonly functions: readonly (readonly string[])[];
  readonly typeNames: readonly (readonly string[])[];
  /** Each entry is one column reference's fields; `*` stands for `A_Star`. */
  readonly columnRefs: readonly (readonly string[])[];
  /** Names a `WITH` introduced — the only relation names besides the table itself. */
  readonly cteNames: ReadonlySet<string>;
  /** Range aliases: the `f` in `financial_data f`, usable as a qualifier. */
  readonly aliasNames: ReadonlySet<string>;
  /** Result column names, which later clauses may sort or filter by. */
  readonly resultNames: ReadonlySet<string>;
  /** A `SELECT … UNION SELECT …` anywhere, including inside a CTE. */
  readonly hasSetOperation: boolean;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A list of name parts as the parser writes them: `[{ String: { sval: 'sum' } }]`,
 * with `A_Star` standing in for `*`. Anything else becomes a name no allowlist
 * holds, so an unexpected shape is refused rather than skipped.
 */
export function namePartsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.map((part) => {
    if (!isRecord(part)) return UNREADABLE_NAME;
    if ('A_Star' in part) return '*';
    const inner = part['String'];
    return (isRecord(inner) ? textOf(inner['sval']) : null) ?? UNREADABLE_NAME;
  });
}

export function inspect(tree: unknown, allowedKeys: ReadonlySet<string>): Inspection {
  const walk = new Walk(allowedKeys);
  walk.visit(tree);
  return walk;
}

/**
 * State in an object rather than an accumulator passed around, so that adding to
 * it is this object changing rather than a parameter being written through.
 */
class Walk implements Inspection {
  readonly unknownKeys: string[] = [];
  readonly tables: TableReference[] = [];
  readonly functions: string[][] = [];
  readonly typeNames: string[][] = [];
  readonly columnRefs: string[][] = [];
  readonly cteNames = new Set<string>();
  readonly aliasNames = new Set<string>();
  readonly resultNames = new Set<string>();
  hasSetOperation = false;

  constructor(private readonly allowedKeys: ReadonlySet<string>) {}

  visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.visit(item);
      return;
    }
    if (!isRecord(value)) return;

    for (const [key, inner] of Object.entries(value)) {
      if (!this.allowedKeys.has(key)) this.unknownKeys.push(key);
      this.note(key, inner);
      this.visit(inner);
    }
  }

  /** The nodes worth remembering. Everything else is only checked for being allowed. */
  private note(key: string, value: unknown): void {
    if (!isRecord(value)) {
      this.noteName(key, value);
      return;
    }

    if (key === 'RangeVar') {
      this.tables.push({
        name: textOf(value['relname']) ?? UNREADABLE_NAME,
        schema: textOf(value['schemaname']),
      });
    } else if (key === 'FuncCall') this.functions.push(namePartsOf(value['funcname']));
    else if (key === 'typeName') this.typeNames.push(namePartsOf(value['names']));
    else if (key === 'ColumnRef') this.columnRefs.push(namePartsOf(value['fields']));
    else if (key === 'SelectStmt') {
      this.hasSetOperation ||= (textOf(value['op']) ?? 'SETOP_NONE') !== 'SETOP_NONE';
    }
  }

  /** The names a query introduces, each of which is a key holding a bare string. */
  private noteName(key: string, value: unknown): void {
    const text = textOf(value);
    if (text === null) return;

    if (key === 'ctename') this.cteNames.add(text);
    else if (key === 'aliasname') this.aliasNames.add(text);
    // `name` is a result column's alias here and an operator elsewhere, where it
    // is a list rather than a string — which is what tells the two apart.
    else if (key === 'name') this.resultNames.add(text);
  }
}
