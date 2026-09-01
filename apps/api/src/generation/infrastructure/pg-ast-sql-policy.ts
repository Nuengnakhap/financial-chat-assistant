import { CanonicalSql, Err, Ok, type Result } from '@fca/domain';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { deparseSync, loadModule, parseSync } from 'pgsql-parser';

import { FINANCIAL_DATA_TABLE } from './financial-data.table';
import { inspect, isRecord, type SelectStatement } from './pg-ast';
import { ALLOWED_KEYS, MAX_ROWS, MAX_SQL_LENGTH } from './sql-allowlist';
import { firstViolation } from './sql-checks';
import { resultColumnsOf, usdNamesOf, type ResultColumn } from './sql-units';
import { asError } from '../../shared/observability/app-logger';
import type { QueryPlan, SqlPolicy, SqlViolation } from '../application/ports/sql-policy.port';

/**
 * The only thing that can turn SQL written by a model into SQL that runs.
 *
 * Text in, tree out, tree walked, and then the **deparsed** tree back out —
 * never the text that arrived. That last step is what makes the guarantee
 * total rather than careful: a comment hiding a second statement, a keyword
 * spelled with a zero-width space, anything at all that the parser reads
 * differently from a person, is discarded along with the original string. What
 * executes is a sentence this process wrote about a tree it accepted.
 *
 * Two more layers sit under it, because a validator is code and code has bugs:
 * the connection belongs to a role that can `SELECT` one table and nothing else,
 * and that role is cut off after three seconds.
 *
 * Synchronous, and on the event loop on purpose: parsing and deparsing one query
 * was measured at 0.042 ms over 2,400 calls, which puts it in the same class as
 * the `JSON.parse` this process already does at every boundary. Input is capped
 * at `MAX_SQL_LENGTH`, which also bounds how deep the tree can be. The tokenizer
 * goes to `CpuPool`; this does not need to.
 */

type ParsedSql = ReturnType<typeof parseSync>;

/**
 * The parser is a WebAssembly module and its synchronous entry points throw
 * until it is loaded. Module scope rather than instance state because the module
 * being loaded is a fact about the process, not about a provider — a second
 * instance would otherwise report a parser it can plainly use as missing.
 */
let parserLoaded = false;

@Injectable()
export class PgAstSqlPolicy implements SqlPolicy, OnModuleInit {
  async onModuleInit(): Promise<void> {
    await loadModule();
    parserLoaded = true;
  }

  validate(raw: string): Result<QueryPlan, SqlViolation> {
    if (!parserLoaded) {
      // A bug, not a rejection: nothing should be validating SQL before the
      // module that boots the parser has finished booting it.
      throw new Error('The SQL parser is not loaded. PgAstSqlPolicy.onModuleInit must run first.');
    }
    // Nothing at all and whitespace are the same question, and the parser
    // answers them differently: it throws for one and returns no statements for
    // the other. Neither is a syntax error worth telling the model about.
    if (raw.trim().length === 0) {
      return Err({ rule: 'empty', message: 'The query is empty.' });
    }
    if (raw.length > MAX_SQL_LENGTH) {
      return Err({
        rule: 'length',
        message: `A query may be at most ${String(MAX_SQL_LENGTH)} characters long.`,
      });
    }

    const parsed = parseTree(raw);
    if (!parsed.ok) return parsed;

    const select = onlySelectOf(parsed.value);
    if (!select.ok) return select;

    return plan(parsed.value, select.value);
  }
}

function plan(tree: ParsedSql, select: SelectStatement): Result<QueryPlan, SqlViolation> {
  const violation = firstViolation(inspect(tree, ALLOWED_KEYS));
  if (violation !== null) return Err(violation);

  // `SELECT FROM financial_data` is valid SQL and comes back as rows with no
  // columns in them, which is nothing anybody can answer from. The top of a
  // `UNION` has no target list either, and is refused above as a set operation.
  if ((select.targetList ?? []).length === 0) {
    return Err({
      rule: 'no_result_columns',
      message: `The query selects nothing. Name the columns you want from ${FINANCIAL_DATA_TABLE}.`,
    });
  }

  const columns = resultColumnsOf(select);
  const ambiguous = firstRepeatedName(columns);
  if (ambiguous !== null) {
    return Err({
      rule: 'duplicate_column',
      message:
        `Two result columns are both called ${ambiguous}. Give each one its own name with AS, ` +
        'so every column in the result can be told apart.',
    });
  }

  // Deparsed from a tree that differs from the accepted one in the row limit
  // alone, which this function is the only writer of.
  const text = deparseSync(withRowLimit(tree, select), { pretty: false });
  return Ok({ sql: CanonicalSql.__fromPolicy(text), usdColumns: usdNamesOf(columns) });
}

/**
 * `SELECT sum(revenue), sum(net_income) FROM …` comes back as two columns both
 * called `sum`, and everything downstream reads a result by column name: the
 * display strings are an object keyed by name, so one of the two cannot even be
 * expressed, and a model copying `sum` has no way to know which it got. Since
 * evidence is matched by value across every column, the figure it copied finds
 * support in the other column and the wrong answer passes verification.
 *
 * So the ambiguity is refused where it starts, rather than papered over further
 * down. It costs a query like `SELECT a.revenue, b.revenue FROM … JOIN …` one
 * round to be told to name them — and the message says exactly that.
 */
function firstRepeatedName(columns: readonly ResultColumn[]): string | null {
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.name)) return `\`${column.name}\``;
    seen.add(column.name);
  }

  return null;
}

function parseTree(raw: string): Result<ParsedSql, SqlViolation> {
  try {
    return Ok(parseSync(raw));
  } catch (error) {
    // The parser's own wording — "syntax error at or near …" — is the most
    // useful thing anyone could say to whoever wrote the query, and the reader
    // here is the model, which is about to write another one.
    return Err({ rule: 'syntax', message: `SQL syntax error: ${asError(error).message}` });
  }
}

function onlySelectOf(tree: ParsedSql): Result<SelectStatement, SqlViolation> {
  const statements = tree.stmts ?? [];
  if (statements.length === 0) {
    return Err({ rule: 'empty', message: 'The query is empty.' });
  }
  if (statements.length > 1) {
    return Err({
      rule: 'multiple_statements',
      message:
        'Exactly one statement is allowed, and the query contains ' +
        `${String(statements.length)}.`,
    });
  }

  // `isRecord` rather than a check against `undefined`: the generated type says
  // the field is always there, and this still holds if one day it is not.
  const node = statements[0]?.stmt;
  if (node === undefined || !('SelectStmt' in node) || !isRecord(node.SelectStmt)) {
    return Err({
      rule: 'not_a_select',
      message: 'Only SELECT is allowed. This connection cannot change anything.',
    });
  }

  return Ok(node.SelectStmt);
}

/**
 * A new tree with the row ceiling written into it, so the limit is enforced by
 * the statement that runs rather than by trimming what comes back. A limit the
 * query already sets is kept when it asks for no more than the ceiling; anything
 * else — absent, larger, `LIMIT ALL`, an expression — is replaced.
 */
function withRowLimit(tree: ParsedSql, select: SelectStatement): ParsedSql {
  const asked = integerLimit(select.limitCount);
  if (asked !== null && asked <= MAX_ROWS) return tree;

  const clamped: SelectStatement = {
    ...select,
    limitCount: { A_Const: { ival: { ival: MAX_ROWS }, location: -1 } },
    limitOption: 'LIMIT_OPTION_COUNT',
  };

  // The statement is rebuilt rather than spread over: what the parser puts
  // beside `stmt` is the original text's byte length, which stops being true the
  // moment the tree changes. The deparser ignores it; carrying it would be a
  // number that says something false.
  return { ...tree, stmts: [{ stmt: { SelectStmt: clamped } }] };
}

function integerLimit(node: unknown): number | null {
  const constant = isRecord(node) ? node['A_Const'] : null;
  if (!isRecord(constant) || constant['isnull'] === true) return null;

  const integer = constant['ival'];
  if (!isRecord(integer)) return null;

  // Protobuf omits a zero, so an `ival` with nothing in it is `LIMIT 0` — which
  // has to be read as zero rather than as unreadable, or asking for no rows
  // would quietly become asking for fifty.
  const value = integer['ival'];
  if (value === undefined) return 0;
  return typeof value === 'number' ? value : null;
}
