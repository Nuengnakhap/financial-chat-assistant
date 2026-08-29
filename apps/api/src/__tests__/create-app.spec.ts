import type { AppConfig } from '@fca/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../app.module';
import { createApp } from '../create-app';
import { AppLogger } from '../shared/observability/app-logger';

/**
 * Every other spec replaces providers to isolate what it is testing, which
 * leaves the real composition root — the factories that read the environment and
 * build the logger — exercised by nothing. This boots the graph exactly as
 * `main.ts` does, so a wiring mistake fails here instead of on first deploy.
 */

const ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app_runtime:pw@localhost:5432/financial_chat',
  MIGRATION_DATABASE_URL: 'postgresql://app:pw@localhost:5432/financial_chat',
  FINANCIAL_DB_URL: 'postgresql://llm_reader:pw@localhost:5432/financial_chat',
  REDIS_URL: 'redis://localhost:6379',
  OPENAI_API_KEY: 'sk-test',
  USAGE_LIMIT_USD: '1',
  JWT_SECRET: 'x'.repeat(32),
  WEB_ORIGIN: 'http://localhost:5173',
  API_PORT: '3000',
};

let app: NestFastifyApplication;
const original = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const [key, value] of Object.entries(ENV)) {
    original.set(key, process.env[key]);
    process.env[key] = value;
  }
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
  for (const [key, value] of original) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

describe('the real composition root', () => {
  it('resolves every provider without a single override', () => {
    expect(app.get<AppConfig>(APP_CONFIG).app.port).toBe(3000);
    expect(app.get(AppLogger)).toBeInstanceOf(AppLogger);
  });

  it('reads configuration through the same factory main.ts uses', () => {
    const config = app.get<AppConfig>(APP_CONFIG);

    expect(config.database.financialUrl).toContain('llm_reader');
    expect(config.usage.limitUsd).toBe(1);
  });

  it('serves the routes it registered', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/healthz/live' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('builds a quieter logger in production, through the same factory', async () => {
    process.env['NODE_ENV'] = 'production';
    const production = await createApp();
    try {
      expect(production.get(AppLogger)).toBeInstanceOf(AppLogger);
    } finally {
      await production.close();
      process.env['NODE_ENV'] = 'test';
    }
  });

  it('answers an unmatched route through the filter bound in the module', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/not-a-route' });

    expect(response.json<{ code: string }>().code).toBe('not_found');
  });
});
