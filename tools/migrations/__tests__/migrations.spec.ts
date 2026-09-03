import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FORBIDDEN, forbiddenIn, risksIn, statementsIn, type RiskKind } from '../policy';

/**
 * The review of generated SQL, made into something that can fail.
 *
 * `drizzle-kit generate` writes what the schema says and knows nothing about
 * locks. Somebody has to read the file — and "somebody reads it" is a habit,
 * which is the kind of rule that holds until the week it matters. Every
 * migration therefore has a note beside it, and the note has to account by name
 * for every locking statement in the file. Missing one fails here; listing one
 * that is not there fails too, because a note copied from the last migration is
 * worse than no note at all.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '../../../apps/api/drizzle');
const NOTES = join(MIGRATIONS, 'notes');

const tagOf = (file: string): string => file.replace(/[.]sql$/u, '');

const migrations = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const notes = readdirSync(NOTES)
  .filter((file) => file.endsWith('.md') && file !== 'TEMPLATE.md')
  .sort();

const read = (path: string): string => readFileSync(path, 'utf8');

/** The kinds listed under `## Locks`, as slugs. `- none` is how you say there are none. */
function lockedIn(note: string): ReadonlySet<string> {
  const section = /##\s+Locks\s*\n([\s\S]*?)(?:\n##\s|$)/u.exec(note)?.[1] ?? '';
  const listed = [...section.matchAll(/^-\s+`([\w-]+)`/gmu)].map((match) => match[1] ?? '');

  return new Set(listed.filter((slug) => slug !== 'none'));
}

describe('the migrations on disk', () => {
  it('has at least one, or this whole file is asserting nothing', () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it('is exactly what the journal says it is', () => {
    // Two branches that each generated a migration merge into a directory with
    // two files and a journal that mentions one. `drizzle-kit check` catches the
    // collision; this catches a file that was added or deleted by hand.
    const parsed: unknown = JSON.parse(read(join(MIGRATIONS, 'meta/_journal.json')));
    const entries = Reflect.get(parsed as object, 'entries');
    const tags = (Array.isArray(entries) ? entries : []).map((entry: unknown) =>
      String(Reflect.get(entry as object, 'tag')),
    );

    expect(tags.sort()).toEqual(migrations.map(tagOf));
  });

  it('has a note beside every one, and a migration behind every note', () => {
    expect(notes.map((file) => file.replace(/[.]md$/u, ''))).toEqual(migrations.map(tagOf));
  });

  it.each(migrations)('%s accounts for every lock it takes', (file) => {
    const risks = [...risksIn(read(join(MIGRATIONS, file)))].sort();
    const note = read(join(NOTES, `${tagOf(file)}.md`));

    expect([...lockedIn(note)].sort()).toEqual(risks);
  });

  it.each(migrations)('%s says how to undo it', (file) => {
    const note = read(join(NOTES, `${tagOf(file)}.md`));
    const rollback = /##\s+Rollback\s*\n([\s\S]*?)(?:\n##\s|$)/u.exec(note)?.[1] ?? '';

    // "It cannot be undone" is an answer. Not having thought about it is not.
    expect(rollback.trim().length).toBeGreaterThan(20);
  });

  it.each(migrations)('%s never adds a column that cannot be filled in', (file) => {
    // `ADD COLUMN … NOT NULL` with no default rewrites the table and then fails
    // on it if it has any rows. There is no note that makes this all right, so
    // it is the one rule here with no way to record an exception.
    expect({ file, [FORBIDDEN]: forbiddenIn(read(join(MIGRATIONS, file))) }).toEqual({
      file,
      [FORBIDDEN]: [],
    });
  });
});

describe('the classifier the rule above rests on', () => {
  const risks = (sql: string): RiskKind[] => [...risksIn(sql)].sort();

  it('reads a rewrite, a scan and a constraint out of generated SQL', () => {
    expect(
      risks(`ALTER TABLE "sessions" ALTER COLUMN "expires_at" SET DATA TYPE timestamp(3);
             ALTER TABLE "sessions" ALTER COLUMN "expires_at" SET NOT NULL;
             ALTER TABLE "sessions" ADD CONSTRAINT "c" CHECK ("sessions"."a" <= "sessions"."b");`),
    ).toEqual(['add-check-constraint', 'alter-column-type', 'set-not-null']);
  });

  it('says nothing about a table the same migration created', () => {
    // Nothing else can be reading a table that did not exist four statements
    // ago. Counting these would make the initial schema the riskiest file here.
    expect(
      risks(`CREATE TABLE "usage_events" ("id" uuid PRIMARY KEY);
             CREATE INDEX "i" ON "usage_events" USING btree ("id");
             ALTER TABLE "usage_events" ADD CONSTRAINT "f" FOREIGN KEY ("id") REFERENCES "users"("id");`),
    ).toEqual([]);
  });

  it('accepts the two forms that were written to avoid the lock', () => {
    expect(risks('ALTER TABLE "m" ADD CONSTRAINT "c" CHECK (a > 0) NOT VALID;')).toEqual([]);
    expect(risks('CREATE INDEX CONCURRENTLY "i" ON "messages" ("created_at");')).toEqual([]);
  });

  it('is not fooled by a comment or by a statement breakpoint', () => {
    const sql = `-- DROP TABLE users;\nCREATE TABLE "a" ("id" uuid);\n--> statement-breakpoint\nDROP COLUMN x FROM "b";`;

    expect(statementsIn(sql)).toHaveLength(2);
    expect(risks(sql)).toEqual(['drop-column']);
  });

  it('catches a column added as NOT NULL with nothing to fill it in with', () => {
    expect(forbiddenIn('ALTER TABLE "m" ADD COLUMN "x" integer NOT NULL;')).toHaveLength(1);
    expect(forbiddenIn('ALTER TABLE "m" ADD COLUMN "x" integer DEFAULT 0 NOT NULL;')).toEqual([]);
  });
});
