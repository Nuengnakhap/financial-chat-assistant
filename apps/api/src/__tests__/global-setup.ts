import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

/**
 * One PostgreSQL and one Redis for the whole integration run. Started once
 * because the point of these tests is what a real server rejects, and paying
 * container startup per file would make that cost enough to stop running them.
 */
let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup(): Promise<void> {
  // The same major versions the application runs against: behaviour that differs
  // between releases is exactly what these tests exist to catch.
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:18-alpine').start(),
    new RedisContainer('redis:8-alpine').start(),
  ]);

  process.env['TEST_DATABASE_URL'] = postgres.getConnectionUri();
  process.env['TEST_REDIS_URL'] = redis.getConnectionUrl();
}

export async function teardown(): Promise<void> {
  await Promise.all([postgres?.stop(), redis?.stop()]);
}
