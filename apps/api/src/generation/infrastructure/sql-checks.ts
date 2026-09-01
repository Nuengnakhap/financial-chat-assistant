import { FINANCIAL_DATA_COLUMNS, FINANCIAL_DATA_TABLE } from './financial-data.table';
import type { Inspection } from './pg-ast';
import { ALLOWED_FUNCTIONS, ALLOWED_TYPES } from './sql-allowlist';
import type { SqlViolation } from '../application/ports/sql-policy.port';

/**
 * The rules, applied to what one walk of the tree found.
 *
 * Order is chosen so the message names the thing a reader would fix first: a
 * query against `users` is reported as the wrong table, not as eight unknown
 * columns. Every message is addressed to the model — it says what was refused
 * and what is available instead, because the next thing that happens is the
 * model writing another query.
 */

const COLUMN_LIST = [...FINANCIAL_DATA_COLUMNS.keys()].join(', ');
const FUNCTION_LIST = [...ALLOWED_FUNCTIONS].join(', ');
const TYPE_LIST = [...ALLOWED_TYPES].join(', ');

export function firstViolation(inspection: Inspection): SqlViolation | null {
  return (
    unknownConstruct(inspection) ??
    setOperation(inspection) ??
    disallowedTable(inspection) ??
    readsNoTable(inspection) ??
    disallowedFunction(inspection) ??
    disallowedType(inspection) ??
    disallowedColumn(inspection)
  );
}

function unknownConstruct(inspection: Inspection): SqlViolation | null {
  const [key] = inspection.unknownKeys;
  if (key === undefined) return null;

  return {
    rule: 'construct',
    message:
      `The query uses a construct this tool does not allow (${key}). Allowed: one SELECT ` +
      `over ${FINANCIAL_DATA_TABLE} with WHERE, GROUP BY, HAVING, ORDER BY, LIMIT/OFFSET, ` +
      'CTEs, subqueries, joins of the table to itself, window functions, CASE and casts.',
  };
}

function setOperation(inspection: Inspection): SqlViolation | null {
  if (!inspection.hasSetOperation) return null;

  return {
    rule: 'construct',
    message:
      'UNION, INTERSECT and EXCEPT are not allowed. One SELECT can answer this: use OR or ' +
      'IN in the WHERE clause, or GROUP BY, to bring the rows together.',
  };
}

function disallowedTable(inspection: Inspection): SqlViolation | null {
  for (const table of inspection.tables) {
    const known = table.name === FINANCIAL_DATA_TABLE || inspection.cteNames.has(table.name);
    // A schema is allowed only when it is the one the table is actually in;
    // anything else is either a different table or a reach at the catalog.
    const schemaOk = table.schema === null || table.schema === 'public';
    if (known && schemaOk) continue;

    return {
      rule: 'table',
      message:
        `Only ${FINANCIAL_DATA_TABLE} can be queried, and the query reads ` +
        `${table.schema === null ? table.name : `${table.schema}.${table.name}`}. ` +
        'This dataset is that one table and nothing else.',
    };
  }

  return null;
}

/**
 * `SELECT 999000000000` reads nothing, breaks no other rule, and comes back as a
 * query result holding a number the model chose. Every figure in an answer is
 * checked against the query results, so a result built out of a literal is a way
 * to manufacture the evidence for one — the one thing this system is for.
 *
 * It does not make that airtight, and nothing at this layer could: arithmetic
 * over real columns can produce any number at all. What it removes is the
 * trivial version, at no cost to a real question — none of which can be answered
 * without reading the table.
 */
function readsNoTable(inspection: Inspection): SqlViolation | null {
  if (inspection.tables.some((table) => table.name === FINANCIAL_DATA_TABLE)) return null;

  return {
    rule: 'no_table',
    message:
      `Every query must read ${FINANCIAL_DATA_TABLE}. A query that selects only literals ` +
      'answers nothing about this dataset.',
  };
}

function disallowedFunction(inspection: Inspection): SqlViolation | null {
  for (const parts of inspection.functions) {
    const name = qualifiedName(parts);
    if (name !== null && ALLOWED_FUNCTIONS.has(name)) continue;

    return {
      rule: 'function',
      message:
        `The function ${parts.join('.')} is not available here. Allowed functions: ` +
        `${FUNCTION_LIST}.`,
    };
  }

  return null;
}

function disallowedType(inspection: Inspection): SqlViolation | null {
  for (const parts of inspection.typeNames) {
    const name = qualifiedName(parts);
    if (name !== null && ALLOWED_TYPES.has(name)) continue;

    return {
      rule: 'type',
      message: `Casting to ${parts.join('.')} is not allowed. Allowed types: ${TYPE_LIST}.`,
    };
  }

  return null;
}

/**
 * One part, or two with `pg_catalog` in front — which is how the parser writes
 * most built-ins, `revenue::numeric` becoming `pg_catalog.numeric`. Any other
 * shape has no name this file will accept.
 */
function qualifiedName(parts: readonly string[]): string | null {
  if (parts.length === 1) return parts[0] ?? null;
  if (parts.length === 2 && parts[0] === 'pg_catalog') return parts[1] ?? null;
  return null;
}

function disallowedColumn(inspection: Inspection): SqlViolation | null {
  const qualifiers = new Set([
    FINANCIAL_DATA_TABLE,
    ...inspection.aliasNames,
    ...inspection.cteNames,
  ]);

  for (const fields of inspection.columnRefs) {
    const unknown = unknownField(fields, inspection.resultNames, qualifiers);
    if (unknown === null) continue;

    return {
      rule: 'column',
      message:
        `${FINANCIAL_DATA_TABLE} has no column ${unknown}. Its columns are: ${COLUMN_LIST}. ` +
        'A name introduced by AS in the same query may also be used.',
    };
  }

  return null;
}

/** The offending part of a column reference, quoted, or `null` when all of it is known. */
function unknownField(
  fields: readonly string[],
  resultNames: ReadonlySet<string>,
  qualifiers: ReadonlySet<string>,
): string | null {
  const known = (field: string): boolean =>
    field === '*' || FINANCIAL_DATA_COLUMNS.has(field) || resultNames.has(field);

  const [first, second] = fields;
  if (fields.length === 1 && first !== undefined) {
    return known(first) ? null : `"${first}"`;
  }
  if (fields.length === 2 && first !== undefined && second !== undefined) {
    if (!qualifiers.has(first)) return `"${first}"`;
    return known(second) ? null : `"${first}.${second}"`;
  }

  return `"${fields.join('.')}"`;
}
