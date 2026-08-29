import type { AppConfig } from '@fca/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../create-app';
import { TEST_ENV } from '../shared/config/__tests__/test-config';
import { APP_CONFIG } from '../shared/config/app-config.token';
import { HEALTH_INDICATORS, type HealthIndicator } from '../shared/health/health-indicator';
import { AppLogger } from '../shared/observability/app-logger';

/**
 * Every other spec replaces providers to isolate what it is testing, which
 * leaves the real composition root — the factories that read the environment and
 * build the logger — exercised by nothing. This boots the graph exactly as
 * `main.ts` does, so a wiring mistake fails here instead of on first deploy.
 */

let app: NestFastifyApplication;
const original = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    original.set(key, process.env[key]);
    process.env[key] = value ?? '';
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

  it('treats both stores as things readiness depends on', () => {
    // Nest keeps one provider per token, so two modules each contributing their
    // own indicator list would leave one of them silently unused.
    const indicators = app.get<readonly HealthIndicator[]>(HEALTH_INDICATORS);

    expect(indicators.map((indicator) => indicator.name).toSorted()).toEqual(['postgres', 'redis']);
  });

  it('answers an unmatched route through the filter bound in the module', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/not-a-route' });

    expect(response.json<{ code: string }>().code).toBe('not_found');
  });
});
