import fastifyCookie from '@fastify/cookie';
import type { AppConfig } from '@fca/config';
import { conversationsContract } from '@fca/contracts';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, isNull } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CookieJar } from '../../__tests__/cookie-jar';
import { until } from '../../__tests__/until';
import { createFastifyAdapter } from '../../bootstrap/fastify';
import { TaskRegistry } from '../../bootstrap/task-registry';
import { IdentityModule } from '../../identity/identity.module';
import { testConfig } from '../../shared/config/__tests__/test-config';
import { APP_CONFIG } from '../../shared/config/app-config.token';
import { DomainErrorFilter } from '../../shared/http/domain-error.filter';
import { AppLogger, createPinoLogger } from '../../shared/observability/app-logger';
import { startHarness, type Harness } from '../../shared/persistence/__tests__/harness';
import { conversations, messages, outboxEvents } from '../../shared/persistence/schema';
import { DOMAIN_EVENT_HANDLERS, type DomainEventHandler } from '../../shared/queue/domain-events';
import { QueueModule } from '../../shared/queue/queue.module';
import { ConversationModule } from '../conversation.module';
import { ConversationDeletionSubscriber } from '../infrastructure/conversation-deletion.subscriber';

/**
 * The delete pipeline with nothing faked: an HTTP request marks the
 * conversation, the pump reads the outbox it was written to, BullMQ carries the
 * job, and the worker removes the rows. Every part of that is the part that
 * ships — a fake queue would prove the handler works and nothing about whether
 * the two halves were ever joined.
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

@Global()
@Module({
  imports: [IdentityModule, ConversationModule, QueueModule],
  providers: [
    { provide: APP_CONFIG, useFactory: integrationConfig },
    {
      provide: AppLogger,
      useValue: new AppLogger(createPinoLogger({ level: 'silent', pretty: false })),
    },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
    TaskRegistry,
    // The same list the composition root builds, for the same reason.
    {
      provide: DOMAIN_EVENT_HANDLERS,
      useFactory: (deletion: ConversationDeletionSubscriber): readonly DomainEventHandler[] => [
        deletion,
      ],
      inject: [ConversationDeletionSubscriber],
    },
  ],
  exports: [APP_CONFIG, AppLogger, TaskRegistry, DOMAIN_EVENT_HANDLERS],
})
class DeletionPipelineModule {}

let app: NestFastifyApplication;
let harness: Harness;
let redis: Redis;

beforeAll(async () => {
  harness = await startHarness();
  redis = new Redis(integrationConfig().redis.url);
  app = await NestFactory.create<NestFastifyApplication>(
    DeletionPipelineModule,
    createFastifyAdapter(),
    { logger: false },
  );
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 120_000);

afterAll(async () => {
  await app.get(TaskRegistry).drain(2_000);
  await app.close();
  await redis.quit();
  await harness.close();
});

beforeEach(async () => {
  await Promise.all([harness.reset(), redis.flushall()]);
});

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  jar: CookieJar,
): Promise<LightMyRequestResponse> {
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({ method, url, cookies: jar.cookies, headers: jar.csrf });
  jar.absorb(response.headers['set-cookie']);

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
      payload: { email, password: 'correct-horse-battery', displayName: 'Ada' },
    });
  jar.absorb(response.headers['set-cookie']);

  return jar;
}

/** Through the contract, so a renamed field fails here rather than three lines later. */
const idOf = (response: LightMyRequestResponse): string =>
  conversationsContract.create.response.parse(response.json()).conversation.id;

const conversationCount = async (): Promise<number> =>
  (await harness.db.select().from(conversations)).length;

async function startConversationWithAMessage(jar: CookieJar): Promise<string> {
  const created = await call('POST', '/api/v1/conversations', jar);
  const id = idOf(created);
  await harness.db.insert(messages).values({
    conversationId: id,
    role: 'user',
    parts: [{ kind: 'text', text: 'hello' }],
    status: 'complete',
    seq: 1,
  });

  return id;
}

describe('deleting a conversation', () => {
  it('takes the rows away, and the messages with them', async () => {
    const jar = await signUp('ada@example.com');
    const id = await startConversationWithAMessage(jar);

    expect((await call('DELETE', `/api/v1/conversations/${id}`, jar)).statusCode).toBe(202);

    await until(async () => (await conversationCount()) === 0, 'the conversation to be removed');
    // Nothing left them behind: the cascade is the database's, not a second
    // delete this code has to remember to run.
    expect(await harness.db.select().from(messages)).toEqual([]);
  });

  it('marks the outbox row published, so the pump does not carry it forever', async () => {
    const jar = await signUp('ada@example.com');
    const id = await startConversationWithAMessage(jar);

    await call('DELETE', `/api/v1/conversations/${id}`, jar);

    await until(async () => {
      const unpublished = await harness.db
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt));

      return unpublished.length === 0;
    }, 'the outbox row to be marked');
  });

  it('does the same thing again when the event is delivered twice', async () => {
    // Exactly what a crash between publishing and marking produces: the row is
    // still unpublished, so the pump carries it again. Doing the work twice has
    // to be as correct as doing it once, or at-least-once delivery would be a
    // liability rather than a guarantee.
    const jar = await signUp('ada@example.com');
    const id = await startConversationWithAMessage(jar);
    await call('DELETE', `/api/v1/conversations/${id}`, jar);
    await until(async () => (await conversationCount()) === 0, 'the first delivery');

    await harness.db.update(outboxEvents).set({ publishedAt: null });

    await until(async () => {
      const rows = await harness.db
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt));

      return rows.length === 0;
    }, 'the redelivery to be handled');
    expect(await conversationCount()).toBe(0);
  });

  it('leaves a conversation nobody asked to delete alone', async () => {
    // The worker deletes only what is marked. `purge` says so in its predicate,
    // so an id arriving from anywhere cannot take a conversation someone is
    // still using.
    const jar = await signUp('ada@example.com');
    const doomed = await startConversationWithAMessage(jar);
    const kept = idOf(await call('POST', '/api/v1/conversations', jar));

    await call('DELETE', `/api/v1/conversations/${doomed}`, jar);

    await until(async () => (await conversationCount()) === 1, 'the doomed one to go');
    const [survivor] = await harness.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, kept));
    expect(survivor?.state).toBe('active');
  });
});
