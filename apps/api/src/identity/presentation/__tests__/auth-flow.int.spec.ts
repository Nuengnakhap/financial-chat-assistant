import fastifyCookie from '@fastify/cookie';
import type { AppConfig } from '@fca/config';
import { CSRF_HEADER, SESSION_COOKIE } from '@fca/contracts';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CookieJar } from '../../../__tests__/cookie-jar';
import { createFastifyAdapter } from '../../../bootstrap/fastify';
import { TaskRegistry } from '../../../bootstrap/task-registry';
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
    // The janitor registers here; without it the module cannot be built at all.
    TaskRegistry,
  ],
  exports: [APP_CONFIG, AppLogger, TaskRegistry],
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
  // Stops the janitor before the pool it sweeps through is closed under it.
  await app.get(TaskRegistry).drain(1_000);
  await app.close();
  await redis.quit();
  await harness.close();
});

beforeEach(async () => {
  // Both stores, not just Postgres: a throttle counter left behind is a
  // neighbouring spec that fails for a reason nothing in it explains.
  await Promise.all([harness.reset(), redis.flushall()]);
});

interface Call {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string;
  readonly payload?: Payload;
  readonly jar?: CookieJar;
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

const signUp = async (jar: CookieJar, overrides: Partial<typeof CREDENTIALS> = {}) =>
  await call({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { ...CREDENTIALS, ...overrides },
    jar,
  });

describe('a session from end to end', () => {
  it('registers, reads itself, refreshes and signs out', async () => {
    const jar = new CookieJar();

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
    const jar = new CookieJar();
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
        headers: { [CSRF_HEADER]: stolen[SESSION_COOKIE.csrf] ?? '' },
      } satisfies InjectOptions);

    expect(replay.statusCode).toBe(401);
  });

  it('signs in again on the same account and keeps both sessions', async () => {
    const first = new CookieJar();
    await signUp(first);

    const second = new CookieJar();
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
    await signUp(new CookieJar());

    const again = await signUp(new CookieJar());

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'conflict' });
  });

  it('refuses a password that is wrong, in the same words as an unknown address', async () => {
    await signUp(new CookieJar());

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
    const ada = new CookieJar();
    await signUp(ada);
    const grace = new CookieJar();
    await signUp(grace, { email: 'grace@example.com', displayName: 'Grace' });

    const mine = await call({ method: 'GET', url: '/api/v1/auth/me', jar: grace });

    // The caller comes from the token, so there is no parameter to tamper with.
    expect(mine.json()).toMatchObject({ user: { email: 'grace@example.com' } });
  });
});

describe('the isolation gate', () => {
  interface ListedSessions {
    readonly sessions: readonly { readonly id: string; readonly current: boolean }[];
  }

  /** `json()` is generic, so the shape is named once here rather than at each use. */
  const sessionsOf = (response: LightMyRequestResponse): ListedSessions['sessions'] =>
    response.json<ListedSessions>().sessions;

  const idsOf = (response: LightMyRequestResponse) => sessionsOf(response).map((s) => s.id);

  it('lists only the caller own sessions, marking the one in hand', async () => {
    const ada = new CookieJar();
    await signUp(ada);
    const second = new CookieJar();
    await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: CREDENTIALS.email, password: CREDENTIALS.password },
      jar: second,
    });
    const grace = new CookieJar();
    await signUp(grace, { email: 'grace@example.com', displayName: 'Grace' });

    const mine = await call({ method: 'GET', url: '/api/v1/auth/sessions', jar: ada });
    const theirs = await call({ method: 'GET', url: '/api/v1/auth/sessions', jar: grace });

    expect(idsOf(mine)).toHaveLength(2);
    expect(idsOf(theirs)).toHaveLength(1);
    // Two devices, exactly one of them the request arrived on.
    const flags = sessionsOf(mine).map((s) => s.current);
    expect(flags.filter(Boolean)).toHaveLength(1);
  });

  it('shows another user nothing of yours, not even that it exists', async () => {
    const ada = new CookieJar();
    await signUp(ada);
    const [target] = idsOf(await call({ method: 'GET', url: '/api/v1/auth/sessions', jar: ada }));
    const grace = new CookieJar();
    await signUp(grace, { email: 'grace@example.com', displayName: 'Grace' });

    const stolen = await call({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${String(target)}`,
      jar: grace,
    });

    // 404 rather than 403: a 403 would confirm the id names something real.
    expect(stolen.statusCode).toBe(404);
    expect((await call({ method: 'GET', url: '/api/v1/auth/me', jar: ada })).statusCode).toBe(200);
  });

  it.each([
    ['an id that names nothing', '3f2504e0-4f89-41d3-9a0c-0305e82c3399'],
    ['an id that is not a uuid', 'not-a-uuid'],
  ])('answers not-found for %s, in the same words', async (_name, id) => {
    const ada = new CookieJar();
    await signUp(ada);

    const response = await call({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${id}`,
      jar: ada,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
  });

  it('ends another device of your own, and only that one', async () => {
    const first = new CookieJar();
    await signUp(first);
    const second = new CookieJar();
    await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: CREDENTIALS.email, password: CREDENTIALS.password },
      jar: second,
    });

    const listed = sessionsOf(
      await call({ method: 'GET', url: '/api/v1/auth/sessions', jar: second }),
    );
    const other = listed.find((s) => !s.current);

    const revoked = await call({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${String(other?.id)}`,
      jar: second,
    });

    expect(revoked.statusCode).toBe(200);
    expect(idsOf(await call({ method: 'GET', url: '/api/v1/auth/sessions', jar: second }))).toEqual(
      [String(listed.find((s) => s.current)?.id)],
    );
    // The revoked device can no longer refresh, which is what revoking means.
    expect(
      (await call({ method: 'POST', url: '/api/v1/auth/refresh', jar: first })).statusCode,
    ).toBe(401);
  });

  it('clears the cookies when you end the session you are asking from', async () => {
    const jar = new CookieJar();
    await signUp(jar);
    const [mine] = sessionsOf(
      await call({ method: 'GET', url: '/api/v1/auth/sessions', jar }),
    ).filter((s) => s.current);

    const response = await call({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${String(mine?.id)}`,
      jar,
    });

    expect(response.statusCode).toBe(200);
    // Ending your own session is signing out, so it has to end the same way —
    // otherwise the browser keeps presenting credentials for a session that is
    // gone until they expire on their own.
    expect((await call({ method: 'GET', url: '/api/v1/auth/me', jar })).statusCode).toBe(401);
  });

  it('refuses the whole surface to a caller with no session', async () => {
    const anonymous = new CookieJar();

    expect(
      (await call({ method: 'GET', url: '/api/v1/auth/sessions', jar: anonymous })).statusCode,
    ).toBe(401);
    expect(
      (
        await call({
          method: 'DELETE',
          url: '/api/v1/auth/sessions/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          jar: anonymous,
        })
      ).statusCode,
    ).toBe(401);
  });
});
