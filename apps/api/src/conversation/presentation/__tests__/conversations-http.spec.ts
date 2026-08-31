import fastifyCookie from '@fastify/cookie';
import { apiFailure, conversationsContract, SESSION_COOKIE } from '@fca/contracts';
import {
  ConversationId,
  Err,
  NotFoundError,
  Ok,
  SessionId,
  UserId,
  ValidationError,
} from '@fca/domain';
import { Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFastifyAdapter } from '../../../bootstrap/fastify';
import { testConfig } from '../../../shared/config/__tests__/test-config';
import { APP_CONFIG } from '../../../shared/config/app-config.token';
import { DomainErrorFilter } from '../../../shared/http/domain-error.filter';
import { ACCESS_TOKEN_VERIFIER, SessionGuard } from '../../../shared/http/session.guard';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { CreateConversationUseCase } from '../../application/use-cases/create-conversation.use-case';
import { DescribeConversationUseCase } from '../../application/use-cases/describe-conversation.use-case';
import { ListConversationsUseCase } from '../../application/use-cases/list-conversations.use-case';
import { RemoveConversationUseCase } from '../../application/use-cases/remove-conversation.use-case';
import { ConversationController } from '../conversation.controller';
import { ConversationsController } from '../conversations.controller';

const ADA = UserId.trusted('e5c9f4a1-1f0e-4a6a-9d4e-0c8b6a3f21d0');
const SESSION = SessionId.trusted('7c0be6ca-984d-40c9-93f6-a1d653f60210');
const ID = ConversationId.trusted('cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21');
const NOW = new Date('2026-08-31T04:05:06.789Z');

const summary = { id: ID, title: 'Revenue', createdAt: NOW, updatedAt: NOW };

const list = { execute: vi.fn() };
const create = { execute: vi.fn() };
const describeOne = { execute: vi.fn() };
const remove = { execute: vi.fn() };
/**
 * The real guard runs, against the narrow capability it declares rather than
 * against a JWT — verifying one has its own spec, and this context could not
 * import identity's issuer even if it wanted to.
 */
const verifyAccessToken = vi.fn();

@Module({
  controllers: [ConversationsController, ConversationController],
  providers: [
    { provide: APP_CONFIG, useValue: testConfig() },
    {
      provide: AppLogger,
      useValue: new AppLogger(createPinoLogger({ level: 'silent', pretty: false })),
    },
    { provide: ListConversationsUseCase, useValue: list },
    { provide: CreateConversationUseCase, useValue: create },
    { provide: DescribeConversationUseCase, useValue: describeOne },
    { provide: RemoveConversationUseCase, useValue: remove },
    { provide: ACCESS_TOKEN_VERIFIER, useValue: { verifyAccessToken } },
    SessionGuard,
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
class ConversationTestModule {}

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(
    ConversationTestModule,
    createFastifyAdapter(),
    { logger: false },
  );
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.resetAllMocks();
  verifyAccessToken.mockReturnValue({ userId: ADA, sessionId: SESSION });
});

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
): Promise<LightMyRequestResponse> {
  const inject: InjectOptions = {
    method,
    url,
    cookies: { [SESSION_COOKIE.access]: 'a-token' },
  };

  return await app.getHttpAdapter().getInstance().inject(inject);
}

const ROUTES = [
  ['GET', '/api/v1/conversations'],
  ['POST', '/api/v1/conversations'],
  ['GET', `/api/v1/conversations/${ID}`],
  ['DELETE', `/api/v1/conversations/${ID}`],
] as const;

describe('the conversation routes', () => {
  it('refuse everyone who is not signed in', async () => {
    verifyAccessToken.mockReturnValue(null);

    const answers = await Promise.all(
      ROUTES.map(async ([method, url]) => [
        `${method} ${url}`,
        (await call(method, url)).statusCode,
      ]),
    );

    expect(Object.fromEntries(answers)).toEqual({
      'GET /api/v1/conversations': 401,
      'POST /api/v1/conversations': 401,
      [`GET /api/v1/conversations/${ID}`]: 401,
      [`DELETE /api/v1/conversations/${ID}`]: 401,
    });
    // Not one of them reached a use case: the guard runs first.
    expect(list.execute).not.toHaveBeenCalled();
    expect(remove.execute).not.toHaveBeenCalled();
  });

  it('scope every call to the caller in the token, never to anything sent', async () => {
    list.execute.mockResolvedValue(Ok({ items: [], nextCursor: null }));

    await call('GET', '/api/v1/conversations?limit=5');

    expect(list.execute).toHaveBeenCalledWith({ userId: ADA }, { limit: 5 });
  });
});

describe('listing conversations', () => {
  it('renders dates as ISO strings, not as whatever JSON does with a Date', async () => {
    list.execute.mockResolvedValue(Ok({ items: [summary], nextCursor: 'next' }));

    const response = await call('GET', '/api/v1/conversations');

    expect(response.statusCode).toBe(200);
    expect(conversationsContract.list.response.parse(response.json())).toEqual({
      items: [
        {
          id: ID,
          title: 'Revenue',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
      nextCursor: 'next',
    });
  });

  it('fills in the limit the contract defaults to', async () => {
    list.execute.mockResolvedValue(Ok({ items: [], nextCursor: null }));

    await call('GET', '/api/v1/conversations');

    expect(list.execute).toHaveBeenCalledWith({ userId: ADA }, { limit: 50 });
  });

  it('refuses a limit past what the contract allows', async () => {
    const response = await call('GET', '/api/v1/conversations?limit=500');

    expect(response.statusCode).toBe(400);
    expect(list.execute).not.toHaveBeenCalled();
  });

  it('answers a tampered cursor with a bad request rather than a server fault', async () => {
    list.execute.mockResolvedValue(Err(new ValidationError('Malformed cursor.')));

    const response = await call('GET', '/api/v1/conversations?cursor=tampered');

    expect(response.statusCode).toBe(400);
    // The domain's own wording stays in the log; the caller gets a sentence
    // written for a person, which says nothing about cursors.
    const failure = apiFailure.parse(response.json());
    expect(failure.code).toBe('validation');
    expect(failure.message).not.toContain('ursor');
  });
});

describe('creating a conversation', () => {
  it('answers 201 with the conversation it made', async () => {
    create.execute.mockResolvedValue(summary);

    const response = await call('POST', '/api/v1/conversations');

    expect(response.statusCode).toBe(201);
    expect(conversationsContract.create.response.parse(response.json())).toEqual({
      conversation: {
        id: ID,
        title: 'Revenue',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    });
  });
});

describe('one conversation', () => {
  it('is read back by its id', async () => {
    describeOne.execute.mockResolvedValue(Ok(summary));

    const response = await call('GET', `/api/v1/conversations/${ID}`);

    expect(response.statusCode).toBe(200);
    expect(conversationsContract.get.response.parse(response.json()).conversation.id).toBe(ID);
  });

  it('answers 404 for one that is not the caller to see', async () => {
    describeOne.execute.mockResolvedValue(Err(new NotFoundError('gone')));

    const response = await call('GET', `/api/v1/conversations/${ID}`);

    // Not 403: that would confirm the id names something real.
    expect(response.statusCode).toBe(404);
  });

  it('is accepted for deletion rather than reported as deleted', async () => {
    remove.execute.mockResolvedValue(Ok(undefined));

    const response = await call('DELETE', `/api/v1/conversations/${ID}`);

    expect(response.statusCode).toBe(202);
    expect(conversationsContract.remove.response.parse(response.json())).toEqual({ ok: true });
  });

  it('answers 404 when there was nothing to delete', async () => {
    remove.execute.mockResolvedValue(Err(new NotFoundError('gone')));

    const response = await call('DELETE', `/api/v1/conversations/${ID}`);

    expect(response.statusCode).toBe(404);
  });
});
