/**
 * What a migration does to a table that already has rows in it.
 *
 * `drizzle-kit generate` writes correct SQL and has no opinion about locks. It
 * will happily emit twenty `ALTER COLUMN … SET DATA TYPE` statements — which is
 * a table rewrite under `ACCESS EXCLUSIVE`, and which is exactly what
 * `0004_millisecond_instants.sql` is. That was harmless because the tables were
 * empty; the point is that nothing anywhere said so, and the next one of those
 * will look identical.
 *
 * So this classifies each statement, and a note beside the migration has to
 * account for every risky one by name. The rule is not "do not do this" — some
 * of these are unavoidable — it is "somebody read the generated SQL and wrote
 * down why this was safe".
 */

export type RiskKind =
  /** A rewrite of every row, under a lock that blocks reads as well as writes. */
  | 'alter-column-type'
  /** A full scan to prove no nulls, under the same lock. */
  | 'set-not-null'
  /** A full scan to validate. `NOT VALID` then `VALIDATE CONSTRAINT` avoids it. */
  | 'add-check-constraint'
  /** The same, plus a lock on the table pointed at. */
  | 'add-foreign-key'
  /** Blocks writes for as long as the build takes. `CONCURRENTLY` does not. */
  | 'create-index'
  /** Not undoable, and the data is gone before anyone reads the release notes. */
  | 'drop-column'
  | 'drop-table';

/** No note excuses this one: it rewrites the table *and* fails if it has rows. */
export const FORBIDDEN = 'add-not-null-column-without-default';

export interface Statement {
  readonly text: string;
  readonly risk: RiskKind | null;
  /** The table it touches, when one can be read out of it. */
  readonly table: string | null;
}

const RULES: readonly { readonly kind: RiskKind; readonly pattern: RegExp }[] = [
  { kind: 'alter-column-type', pattern: /ALTER\s+COLUMN\s+\S+\s+SET\s+DATA\s+TYPE/iu },
  { kind: 'set-not-null', pattern: /ALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL/iu },
  { kind: 'add-check-constraint', pattern: /ADD\s+CONSTRAINT\s+\S+\s+CHECK/iu },
  { kind: 'add-foreign-key', pattern: /ADD\s+CONSTRAINT\s+\S+\s+FOREIGN\s+KEY/iu },
  { kind: 'create-index', pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX/iu },
  { kind: 'drop-column', pattern: /DROP\s+COLUMN/iu },
  { kind: 'drop-table', pattern: /DROP\s+TABLE/iu },
];

/** Named in the statement, so a lock can be attributed to the table it is on. */
function tableIn(statement: string): string | null {
  const altered = /ALTER\s+TABLE\s+"?([\w.]+)"?/iu.exec(statement);
  const created = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w.]+)"?/iu.exec(statement);
  const indexed = /\bON\s+"?([\w.]+)"?/iu.exec(statement);
  const dropped = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([\w.]+)"?/iu.exec(statement);

  return altered?.[1] ?? dropped?.[1] ?? created?.[1] ?? indexed?.[1] ?? null;
}

function riskIn(statement: string): RiskKind | null {
  // Already deferred: the scan happens later, out of the lock.
  if (/NOT\s+VALID/iu.test(statement)) return null;
  if (/CONCURRENTLY/iu.test(statement)) return null;

  return RULES.find((rule) => rule.pattern.test(statement))?.kind ?? null;
}

export function statementsIn(sql: string): readonly Statement[] {
  return sql
    .split(/-->\s*statement-breakpoint|;/u)
    .map((piece) =>
      piece
        .replaceAll(/--[^\n]*/gu, '')
        .replaceAll(/\s+/gu, ' ')
        .trim(),
    )
    .filter((piece) => piece !== '')
    .map((text) => ({ text, risk: riskIn(text), table: tableIn(text) }));
}

/**
 * The risks in one migration, minus everything on a table it created itself.
 *
 * A unique index on a table that came into existence four statements ago locks
 * nothing, because nothing else can be reading it yet. Counting those would
 * make the initial schema the riskiest file in the repository and teach
 * everyone to skim the list.
 */
export function risksIn(sql: string): ReadonlySet<RiskKind> {
  const statements = statementsIn(sql);
  const born = new Set(
    statements
      .filter((statement) => /^CREATE\s+TABLE/iu.test(statement.text))
      .map((statement) => statement.table),
  );

  const risks = new Set<RiskKind>();
  for (const statement of statements) {
    if (statement.risk === null || born.has(statement.table)) continue;
    risks.add(statement.risk);
  }

  return risks;
}

/** `ADD COLUMN … NOT NULL` with nothing to fill it in with. */
export function forbiddenIn(sql: string): readonly string[] {
  return statementsIn(sql)
    .filter(
      (statement) =>
        /ADD\s+COLUMN/iu.test(statement.text) &&
        /NOT\s+NULL/iu.test(statement.text) &&
        !/DEFAULT/iu.test(statement.text),
    )
    .map((statement) => statement.text);
}
