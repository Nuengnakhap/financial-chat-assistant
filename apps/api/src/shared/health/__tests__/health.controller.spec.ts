import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../../app.module';
import { createFastifyAdapter } from '../../../bootstrap/fastify';
import { testConfig } from '../../config/__tests__/test-config';
import { APP_CONFIG } from '../../config/app-config.token';
import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import { HEALTH_INDICATORS, READINESS_TIMEOUT_MS, type HealthIndicator } from '../health-indicator';
import { ReadinessProbe } from '../readiness';

let app: NestFastifyApplication | undefined;

/** Boots the real module graph, replacing only what a test needs to control. */
async function boot(indicators: readonly HealthIndicator[]): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(testConfig())
    .overrideProvider(AppLogger)
    .useValue(new AppLogger(createPinoLogger({ level: 'silent', pretty: false })))
    .overrideProvider(HEALTH_INDICATORS)
    .useValue(indicators)
    .overrideProvider(READINESS_TIMEOUT_MS)
    .useValue(50)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const get = async (path: string) => {
  if (app === undefined) throw new Error('boot() was not called');
  return await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: path });
};

afterEach(async () => {
  // boot() may have thrown before assigning.
  await app?.close();
});

describe('liveness', () => {
  it('answers without touching a dependency', async () => {
    await boot([{ name: 'always-down', check: () => Promise.reject(new Error('down')) }]);

    // A dependency outage must never restart the process.
    const response = await get('/healthz/live');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('readiness', () => {
  it('is ready when every registered dependency answers', async () => {
    await boot([{ name: 'db', check: () => Promise.resolve() }]);

    expect((await get('/healthz/ready')).statusCode).toBe(200);
  });

  it('is ready when nothing is registered yet', async () => {
    await boot([]);

    expect((await get('/healthz/ready')).statusCode).toBe(200);
  });

  it('refuses traffic when a dependency is down', async () => {
    await boot([
      { name: 'db', check: () => Promise.resolve() },
      { name: 'redis', check: () => Promise.reject(new Error('ECONNREFUSED')) },
    ]);

    expect((await get('/healthz/ready')).statusCode).toBe(503);
  });

  it('treats a dependency that never answers as down, not as pending', async () => {
    await boot([{ name: 'stalled', check: () => new Promise<void>(() => undefined) }]);

    const response = await get('/healthz/ready');

    expect(response.statusCode).toBe(503);
  });

  it('refuses traffic once shutdown has begun, while every dependency is still healthy', async () => {
    const booted = await boot([{ name: 'db', check: () => Promise.resolve() }]);
    expect((await get('/healthz/ready')).statusCode).toBe(200);

    booted.get(ReadinessProbe).refuse();

    expect((await get('/healthz/ready')).statusCode).toBe(503);
    // Liveness stays true: this process is stopping, not broken.
    expect((await get('/healthz/live')).statusCode).toBe(200);
  });

  it('says nothing about which dependency failed', async () => {
    // Names long enough not to collide with the random request id in the body:
    // a two-letter name would match one of these responses in about ten.
    await boot([
      {
        name: 'primary-datastore',
        check: () => Promise.reject(new Error('password authentication failed')),
      },
    ]);

    const response = await get('/healthz/ready');

    expect(response.body).not.toContain('password');
    expect(response.body).not.toContain('primary-datastore');
  });
});
