import { loadConfig, type AppConfig, type EnvSource } from '@fca/config';

/**
 * Built by the real loader rather than hand-written, so a new required variable
 * breaks every spec that boots the app instead of leaving them with a config
 * shape that quietly stopped matching the one production uses.
 */
export const TEST_ENV: EnvSource = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app_runtime:pw@localhost:5432/financial_chat',
  MIGRATION_DATABASE_URL: 'postgresql://app:pw@localhost:5432/financial_chat',
  FINANCIAL_DB_URL: 'postgresql://llm_reader:pw@localhost:5432/financial_chat',
  REDIS_URL: 'redis://localhost:6379',
  OPENAI_API_KEY: 'sk-test',
  USAGE_LIMIT_USD: '1',
  JWT_SECRET: 'x'.repeat(32),
  API_PORT: '3000',
};

export function testConfig(): AppConfig {
  return loadConfig(TEST_ENV);
}
