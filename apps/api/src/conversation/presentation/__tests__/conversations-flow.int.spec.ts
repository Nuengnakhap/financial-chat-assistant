import fastifyCookie from '@fastify/cookie';
import type { AppConfig } from '@fca/config';
import { apiFailure, conversationsContract } from '@fca/contracts';
import { Ok, ReservationId } from '@fca/domain';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CookieJar } from '../../../__tests__/cookie-jar';
import { createFastifyAdapter } from '../../../bootstrap/fastify';
import { TaskRegistry } from '../../../bootstrap/task-registry';
import { IdentityModule } from '../../../identity/identity.module';
import { testConfig } from '../../../shared/config/__tests__/test-config';
import { APP_CONFIG } from '../../../shared/config/app-config.token';
import { DomainErrorFilter } from '../../../shared/http/domain-error.filter';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { startHarness, type Harness } from '../../../shared/persistence/__tests__/harness';
import { conversations, outboxEvents } from '../../../shared/persistence/schema';
import { GENERATION_BUDGET, type GenerationBudget } from '../../application/ports/budget.port';
import { ConversationModule } from '../../conversation.module';

/**
 * Nothing faked: real Fastify, real cookies, real CSRF, real PostgreSQL. The
 * unit specs prove each piece decides correctly; this proves two people cannot
 * see each other's conversations through the wiring that actually ships.
 */
function integrationConfig(): AppConfig {
  const database = process.env['TEST_DATABASE_URL'];
  const redis = process.env['TEST_REDIS_URL'];
  if (database === undefined || redis === undefined) {
    throw new Error('TEST_DATABASE_URL / TEST_REDIS_URL are not set; global setup did not run');
  }

  const base = testConfig();
  return { ...base, database: { ...base.database, url: database }, redis: { url: redis } };
}

/**
 * A budget that always grants. This file is about conversations, and the real
 * one lives in another context — which the boundary rules will not let a
 * context reach into, and rightly: what binds the two is the composition root,
 * and that is exercised where the whole graph is booted.
 */
const budget: GenerationBudget = {
  reserve: async (userId) =>
    await Promise.resolve(
      Ok({
        userId,
        id: ReservationId.trusted('7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'),
        windowStart: new Date('2026-09-02T14:00:00.000Z'),
      }),
    ),
  release: async () => await Promise.resolve(),
};

@Global()
@Module({
  imports: [IdentityModule, ConversationModule],
  providers: [
    { provide: GENERATION_BUDGET, useValue: budget },
    { provide: APP_CONFIG, useFactory: integrationConfig },
    {
      provide: AppLogger,
      useValue: new AppLogger(createPinoLogger({ level: 'silent', pretty: false })),
    },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
    TaskRegistry,
  ],
  exports: [APP_CONFIG, AppLogger, TaskRegistry, GENERATION_BUDGET],
})
class ConversationFlowModule {}

let app: NestFastifyApplication;
let harness: Harness;
let redis: Redis;

beforeAll(async () => {
  harness = await startHarness();
  redis = new Redis(integrationConfig().redis.url);
  app = await NestFactory.create<NestFastifyApplication>(
    ConversationFlowModule,
    createFastifyAdapter(),
    { logger: false },
  );
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 120_000);

afterAll(async () => {
  await app.get(TaskRegistry).drain(1_000);
  await app.close();
  await redis.quit();
  await harness.close();
});

beforeEach(async () => {
  await Promise.all([harness.reset(), redis.flushall()]);
});

interface Call {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string;
  readonly jar?: CookieJar;
  readonly withoutCsrf?: boolean;
}

async function call(options: Call): Promise<LightMyRequestResponse> {
  const inject: InjectOptions = { method: options.method, url: options.url };
  const jar = options.jar;
  if (jar !== undefined) {
    inject.cookies = jar.cookies;
    if (options.withoutCsrf !== true) inject.headers = jar.csrf;
  }

  const response = await app.getHttpAdapter().getInstance().inject(inject);
  options.jar?.absorb(response.headers['set-cookie']);

  return response;
}

async function signUp(email: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery', displayName: email.split('@')[0] },
    });
  jar.absorb(response.headers['set-cookie']);

  return jar;
}

/**
 * Read through the contract the browser reads, so every assertion below is also
 * a check that the shape on the wire is the one both sides agreed on. A field
 * renamed here fails as a parse error naming the field, not as `undefined`
 * three lines later.
 */
const asPage = (response: LightMyRequestResponse) =>
  conversationsContract.list.response.parse(response.json());
const asConversation = (response: LightMyRequestResponse) =>
  conversationsContract.get.response.parse(response.json()).conversation;
const asFailure = (response: LightMyRequestResponse) => apiFailure.parse(response.json());

const start = async (jar: CookieJar): Promise<string> => {
  const created = await call({ method: 'POST', url: '/api/v1/conversations', jar });
  expect(created.statusCode).toBe(201);

  return asConversation(created).id;
};

describe('a conversation from end to end', () => {
  it('is created, listed, read and asked to go', async () => {
    const jar = await signUp('ada@example.com');

    const id = await start(jar);
    const listed = asPage(await call({ method: 'GET', url: '/api/v1/conversations', jar }));
    expect(listed.items.map((row) => row.id)).toEqual([id]);
    expect(listed.nextCursor).toBeNull();

    const read = await call({ method: 'GET', url: `/api/v1/conversations/${id}`, jar });
    expect(asConversation(read).title).toBe('New chat');

    const removed = await call({ method: 'DELETE', url: `/api/v1/conversations/${id}`, jar });
    expect(removed.statusCode).toBe(202);

    // Gone from every read, in the same answer that accepted the request.
    expect(
      (await call({ method: 'GET', url: `/api/v1/conversations/${id}`, jar })).statusCode,
    ).toBe(404);
    expect(asPage(await call({ method: 'GET', url: '/api/v1/conversations', jar })).items).toEqual(
      [],
    );
  });

  it('records the deletion in the outbox, in the transaction that hid it', async () => {
    const jar = await signUp('ada@example.com');
    const id = await start(jar);

    await call({ method: 'DELETE', url: `/api/v1/conversations/${id}`, jar });

    // The row is still there, in `deleting`, and the event that will finish the
    // job is committed with it. Either both happened or neither did.
    const [row] = await harness.db.select().from(conversations).where(eq(conversations.id, id));
    expect(row?.state).toBe('deleting');
    const events = await harness.db.select().from(outboxEvents);
    expect(events.map((event) => ({ type: event.type, aggregateId: event.aggregateId }))).toEqual([
      { type: 'conversation.delete_requested', aggregateId: id },
    ]);
  });

  it('does not queue a second deletion for a second click', async () => {
    const jar = await signUp('ada@example.com');
    const id = await start(jar);

    await call({ method: 'DELETE', url: `/api/v1/conversations/${id}`, jar });
    const again = await call({ method: 'DELETE', url: `/api/v1/conversations/${id}`, jar });

    expect(again.statusCode).toBe(404);
    expect(await harness.db.select().from(outboxEvents)).toHaveLength(1);
  });

  it('pages the rail without repeating or skipping a conversation', async () => {
    const jar = await signUp('ada@example.com');
    const made = await Promise.all(Array.from({ length: 5 }, async () => await start(jar)));

    const first = asPage(await call({ method: 'GET', url: '/api/v1/conversations?limit=2', jar }));
    const second = asPage(
      await call({
        method: 'GET',
        url: `/api/v1/conversations?limit=2&cursor=${encodeURIComponent(String(first.nextCursor))}`,
        jar,
      }),
    );

    const seen = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(seen).size).toBe(4);
    expect(seen.every((id) => made.includes(id))).toBe(true);
  });

  it('answers a cursor somebody edited with a bad request', async () => {
    const jar = await signUp('ada@example.com');

    const response = await call({ method: 'GET', url: '/api/v1/conversations?cursor=nope', jar });

    expect(response.statusCode).toBe(400);
    expect(asFailure(response).code).toBe('validation');
  });
});

describe('another person', () => {
  it('cannot see, read or delete a conversation that is not theirs', async () => {
    const ada = await signUp('ada@example.com');
    const grace = await signUp('grace@example.com');
    const id = await start(ada);

    expect(
      asPage(await call({ method: 'GET', url: '/api/v1/conversations', jar: grace })).items,
    ).toEqual([]);
    // 404 rather than 403, so asking cannot confirm the id names anything.
    expect(
      (await call({ method: 'GET', url: `/api/v1/conversations/${id}`, jar: grace })).statusCode,
    ).toBe(404);
    expect(
      (await call({ method: 'DELETE', url: `/api/v1/conversations/${id}`, jar: grace })).statusCode,
    ).toBe(404);

    // And nothing happened to it.
    expect(
      (await call({ method: 'GET', url: `/api/v1/conversations/${id}`, jar: ada })).statusCode,
    ).toBe(200);
  });
});

describe('a mutation from another site', () => {
  it('is refused even though the browser sent the cookies', async () => {
    const jar = await signUp('ada@example.com');

    const response = await call({
      method: 'POST',
      url: '/api/v1/conversations',
      jar,
      withoutCsrf: true,
    });

    expect(response.statusCode).toBe(403);
  });
});
