import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * One PostgreSQL for the whole integration run. Started once because the point
 * of these tests is what a real database rejects, and paying container startup
 * per file would make that cost enough to stop running them.
 */
let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  // The same major version the application runs against: a constraint that
  // behaves differently on 16 and 18 is exactly what these tests exist to catch.
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  process.env['TEST_DATABASE_URL'] = container.getConnectionUri();
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
