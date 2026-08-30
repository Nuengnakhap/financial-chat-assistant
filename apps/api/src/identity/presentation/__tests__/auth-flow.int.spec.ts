import fastifyCookie from '@fastify/cookie';
import type { AppConfig } from '@fca/config';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createFastifyAdapter } from '../../../bootstrap/fastify';
import { testConfig } from '../../../shared/config/__tests__/test-config';
import { APP_CONFIG } from '../../../shared/config/app-config.token';
import { DomainErrorFilter } from '../../../shared/http/domain-error.filter';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { startHarness, type Harness } from '../../../shared/persistence/__tests__/harness';
import { IdentityModule } from '../../identity.module';

/**
 * The whole stack with nothing faked: real Fastify, real cookies, real argon2,
 * real JWT, real PostgreSQL and real Redis. The unit specs prove each piece;
 * this proves they were wired to each other.
 */
function integrationConfig(): AppConfig {
  const database = process.env['TEST_DATABASE_URL'];
  const redis = process.env['TEST_REDIS_URL'];
  if (database === undefined || redis === undefined) {
    throw new Error('TEST_DATABASE_URL / TEST_REDIS_URL are not set; global setup did not run');
  }

  const base = testConfig();
  return {
    ...base,
    database: { ...base.database, url: database },
    redis: { url: redis },
  };
}

@Global()
@Module({
  imports: [IdentityModule],
  providers: [
    { provide: APP_CONFIG, useFactory: integrationConfig },
    {
      provide: AppLogger,
      useValue: new AppLogger(createPinoLogger({ level: 'silent', pretty: false })),
    },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
  exports: [APP_CONFIG, AppLogger],
})
class AuthFlowModule {}

let app: NestFastifyApplication;
let harness: Harness;
let redis: Redis;

const CREDENTIALS = {
  email: 'ada@example.com',
  password: 'correct-horse-battery',
  displayName: 'Ada',
};

beforeAll(async () => {
  // Applies the real migrations before anything connects as the runtime role.
  harness = await startHarness();
  redis = new Redis(integrationConfig().redis.url);
  app = await NestFactory.create<NestFastifyApplication>(AuthFlowModule, createFastifyAdapter(), {
    logger: false,
  });
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await redis.quit();
  await harness.close();
});

beforeEach(async () => {
  // Both stores, not just Postgres: a throttle counter left behind is a
  // neighbouring spec that fails for a reason nothing in it explains.
  await Promise.all([harness.reset(), redis.flushall()]);
});

/** Keeps whatever the server last set, the way a browser would. */
class Jar {
  private readonly values = new Map<string, string>();

  absorb(header: string | string[] | undefined): void {
    const all = header === undefined ? [] : Array.isArray(header) ? header : [header];
    for (const cookie of all) {
      const [pair] = cookie.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (pair === undefined || separator < 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value === '') this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  get cookies(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  get csrf(): Record<string, string> {
    const token = this.values.get('fca_csrf');
    return token === undefined ? {} : { 'x-csrf-token': token };
  }
}

interface Call {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: Payload;
  readonly jar?: Jar;
}

type Payload = NonNullable<InjectOptions['payload']>;

async function call(options: Call): Promise<LightMyRequestResponse> {
  // Built key by key: `exactOptionalPropertyTypes` refuses an explicit
  // `undefined` where the option is merely optional.
  const inject: InjectOptions = { method: options.method, url: options.url };
  if (options.payload !== undefined) inject.payload = options.payload;
  const jar = options.jar;
  if (jar !== undefined) {
    inject.cookies = jar.cookies;
    inject.headers = jar.csrf;
  }

  const response = await app.getHttpAdapter().getInstance().inject(inject);
  options.jar?.absorb(response.headers['set-cookie']);

  return response;
}

const signUp = async (jar: Jar, overrides: Partial<typeof CREDENTIALS> = {}) =>
  await call({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { ...CREDENTIALS, ...overrides },
    jar,
  });

describe('a session from end to end', () => {
  it('registers, reads itself, refreshes and signs out', async () => {
    const jar = new Jar();

    expect((await signUp(jar)).statusCode).toBe(201);
    expect((await call({ method: 'GET', url: '/api/v1/auth/me', jar })).json()).toMatchObject({
      user: { email: CREDENTIALS.email, displayName: CREDENTIALS.displayName },
    });

    const refreshed = await call({ method: 'POST', url: '/api/v1/auth/refresh', jar });
    expect(refreshed.statusCode).toBe(200);

    // Still signed in on the tokens the refresh handed back, not the old ones.
    expect((await call({ method: 'GET', url: '/api/v1/auth/me', jar })).statusCode).toBe(200);

    expect((await call({ method: 'POST', url: '/api/v1/auth/logout', jar })).statusCode).toBe(200);
    expect((await call({ method: 'GET', url: '/api/v1/auth/me', jar })).statusCode).toBe(401);
  });

  it('refuses a refresh token that was already rotated away', async () => {
    const jar = new Jar();
    await signUp(jar);
    const stolen = jar.cookies;

    await call({ method: 'POST', url: '/api/v1/auth/refresh', jar });

    // The copy taken before the real client refreshed. Outside the grace window
    // this is theft; inside it, a race — either way it buys nothing.
    const replay = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: stolen,
        headers: { 'x-csrf-token': stolen['fca_csrf'] ?? '' },
      } satisfies InjectOptions);

    expect(replay.statusCode).toBe(401);
  });

  it('signs in again on the same account and keeps both sessions', async () => {
    const first = new Jar();
    await signUp(first);

    const second = new Jar();
    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: CREDENTIALS.email, password: CREDENTIALS.password },
      jar: second,
    });

    expect(response.statusCode).toBe(200);
    // A second sign-in starts its own lineage; the first device stays signed in.
    expect((await call({ method: 'GET', url: '/api/v1/auth/me', jar: first })).statusCode).toBe(
      200,
    );
    expect((await call({ method: 'GET', url: '/api/v1/auth/me', jar: second })).statusCode).toBe(
      200,
    );
  });

  it('reports a taken address without saying anything else', async () => {
    await signUp(new Jar());

    const again = await signUp(new Jar());

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'conflict' });
  });

  it('refuses a password that is wrong, in the same words as an unknown address', async () => {
    await signUp(new Jar());

    const wrongPassword = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: CREDENTIALS.email, password: 'wrong-but-long-enough' },
    });
    const unknownAddress = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: CREDENTIALS.password },
    });

    const said = (response: { json: () => unknown }) => {
      const { code, message } = response.json() as { code: string; message: string };
      return { code, message };
    };

    // Only the request id may differ. Anything else here is a way to find out
    // which addresses have accounts.
    expect(wrongPassword.statusCode).toBe(unknownAddress.statusCode);
    expect(said(wrongPassword)).toEqual(said(unknownAddress));
    expect(wrongPassword.statusCode).toBe(401);
  });

  it('one user cannot read another', async () => {
    const ada = new Jar();
    await signUp(ada);
    const grace = new Jar();
    await signUp(grace, { email: 'grace@example.com', displayName: 'Grace' });

    const mine = await call({ method: 'GET', url: '/api/v1/auth/me', jar: grace });

    // The caller comes from the token, so there is no parameter to tamper with.
    expect(mine.json()).toMatchObject({ user: { email: 'grace@example.com' } });
  });
});
