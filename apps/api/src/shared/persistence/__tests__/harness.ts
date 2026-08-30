import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ConversationId, UserId } from '@fca/domain';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import * as schema from '../schema';

export type TestDb = NodePgDatabase<typeof schema>;

export interface Harness {
  readonly db: TestDb;
  readonly pool: Pool;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Applies the real migration rather than pushing the schema, so what the tests
 * run against is the SQL that will run in production — a constraint that only
 * exists in the TypeScript would otherwise pass here and be absent in the wild.
 */
export async function startHarness(): Promise<Harness> {
  const connectionString = process.env['TEST_DATABASE_URL'];
  if (connectionString === undefined) {
    throw new Error('TEST_DATABASE_URL is not set; the integration global setup did not run');
  }

  const pool = new Pool({ connectionString, max: 5 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: findMigrationsFolder() });

  return {
    db,
    pool,
    reset: async () => {
      // RESTART IDENTITY so outbox ids start from 1 in every test, and CASCADE
      // because the tables are a graph.
      await db.execute(
        sql`TRUNCATE TABLE users, sessions, session_tokens, conversations, messages, outbox_events RESTART IDENTITY CASCADE`,
      );
    },
    close: async () => {
      await pool.end();
    },
  };
}

/** Vitest runs from the repository root, drizzle-kit writes relative to apps/api. */
function findMigrationsFolder(): string {
  for (const candidate of ['drizzle', join('apps', 'api', 'drizzle')]) {
    if (existsSync(join(process.cwd(), candidate, 'meta', '_journal.json'))) return candidate;
  }
  throw new Error(`no drizzle migrations found from ${process.cwd()}; run pnpm db:generate`);
}

export async function insertUser(db: TestDb, email: string): Promise<UserId> {
  const [row] = await db
    .insert(schema.users)
    .values({ email, displayName: email.split('@')[0] ?? 'user', passwordHash: 'not-a-real-hash' })
    .returning({ id: schema.users.id });

  if (row === undefined) throw new Error('user insert returned no row');

  return row.id as UserId;
}

export async function insertConversation(
  db: TestDb,
  userId: UserId,
  title = 'New chat',
): Promise<ConversationId> {
  const [row] = await db
    .insert(schema.conversations)
    .values({ userId, title })
    .returning({ id: schema.conversations.id });

  if (row === undefined) throw new Error('conversation insert returned no row');

  return row.id as ConversationId;
}

/**
 * Drizzle wraps a driver error, so the constraint name lives on `cause` rather
 * than in the message. Walking the chain keeps the assertions about *which*
 * constraint fired, which is the whole point of testing them.
 */
export async function violationOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join(' | ');
  }
  throw new Error('expected the database to reject this, but it was accepted');
}
