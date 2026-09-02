import fastifyCookie from '@fastify/cookie';
import {
  apiFailure,
  conversationsContract,
  messagesContract,
  SESSION_COOKIE,
} from '@fca/contracts';
import {
  ClientMessageId,
  ConflictError,
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
import { ListMessagesUseCase } from '../../application/use-cases/list-messages.use-case';
import { RemoveConversationUseCase } from '../../application/use-cases/remove-conversation.use-case';
import { StartGenerationUseCase } from '../../application/use-cases/start-generation.use-case';
import { ConversationController } from '../conversation.controller';
import { ConversationsController } from '../conversations.controller';
import { MessagesController } from '../messages.controller';

const ADA = UserId.trusted('e5c9f4a1-1f0e-4a6a-9d4e-0c8b6a3f21d0');
const SESSION = SessionId.trusted('7c0be6ca-984d-40c9-93f6-a1d653f60210');
const ID = ConversationId.trusted('cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21');
const NOW = new Date('2026-08-31T04:05:06.789Z');

const summary = { id: ID, title: 'Revenue', createdAt: NOW, updatedAt: NOW };

const list = { execute: vi.fn() };
const create = { execute: vi.fn() };
const describeOne = { execute: vi.fn() };
const remove = { execute: vi.fn() };
const history = { execute: vi.fn() };
const startGeneration = { execute: vi.fn() };
/**
 * The real guard runs, against the narrow capability it declares rather than
 * against a JWT — verifying one has its own spec, and this context could not
 * import identity's issuer even if it wanted to.
 */
const verifyAccessToken = vi.fn();

@Module({
  controllers: [ConversationsController, ConversationController, MessagesController],
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
    { provide: ListMessagesUseCase, useValue: history },
    { provide: StartGenerationUseCase, useValue: startGeneration },
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
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  const inject: InjectOptions = {
    method,
    url,
    cookies: { [SESSION_COOKIE.access]: 'a-token' },
    ...(payload === undefined ? {} : { payload }),
  };

  return await app.getHttpAdapter().getInstance().inject(inject);
}

const ROUTES = [
  ['GET', '/api/v1/conversations'],
  ['POST', '/api/v1/conversations'],
  ['GET', `/api/v1/conversations/${ID}`],
  ['DELETE', `/api/v1/conversations/${ID}`],
  ['GET', `/api/v1/conversations/${ID}/messages`],
  ['POST', `/api/v1/conversations/${ID}/messages`],
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
      [`GET /api/v1/conversations/${ID}/messages`]: 401,
      [`POST /api/v1/conversations/${ID}/messages`]: 401,
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

describe('the history of a conversation', () => {
  const MESSAGE = {
    id: '2b8e1b4a-6a1e-4d5e-9c3f-0f1a2b3c4d5e',
    conversationId: ID,
    seq: 1,
    role: 'user' as const,
    status: 'complete' as const,
    parts: [{ kind: 'text', text: 'hello' }],
    verification: null,
    createdAt: NOW,
  };

  it('renders what the client will read, shape and all', async () => {
    history.execute.mockResolvedValue(Ok({ items: [MESSAGE], nextCursor: 'older' }));

    const response = await call('GET', `/api/v1/conversations/${ID}/messages`);

    expect(response.statusCode).toBe(200);
    expect(conversationsContract.listMessages.response.parse(response.json())).toEqual({
      items: [
        {
          id: MESSAGE.id,
          conversationId: ID,
          seq: 1,
          role: 'user',
          status: 'complete',
          parts: [{ kind: 'text', text: 'hello' }],
          verification: null,
          usage: null,
          error: null,
          createdAt: NOW.toISOString(),
        },
      ],
      nextCursor: 'older',
    });
  });

  it('fills in the limit the contract defaults to', async () => {
    history.execute.mockResolvedValue(Ok({ items: [], nextCursor: null }));

    await call('GET', `/api/v1/conversations/${ID}/messages`);

    expect(history.execute).toHaveBeenCalledWith({ userId: ADA }, ID, { limit: 100 });
  });

  it('refuses a limit past what the contract allows', async () => {
    const response = await call('GET', `/api/v1/conversations/${ID}/messages?limit=500`);

    expect(response.statusCode).toBe(400);
    expect(history.execute).not.toHaveBeenCalled();
  });

  it('answers 404 for a conversation that is not the caller to read', async () => {
    history.execute.mockResolvedValue(Err(new NotFoundError('gone')));

    const response = await call('GET', `/api/v1/conversations/${ID}/messages`);

    expect(response.statusCode).toBe(404);
  });
});

describe('asking a question', () => {
  const ANSWER = '7f3c9d2e-5b4a-4c1d-8e6f-9a0b1c2d3e4f';
  const CLIENT_ID = '9b1e2f3a-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
  const url = `/api/v1/conversations/${ID}/messages`;
  const question = {
    content: 'What was the revenue of Apple in 2024?',
    clientMessageId: CLIENT_ID,
  };

  it('answers 202 with the path the client attaches to', async () => {
    startGeneration.execute.mockResolvedValue(Ok({ assistantMessageId: ANSWER, resumed: false }));

    const response = await call('POST', url, question);

    expect(response.statusCode).toBe(202);
    // Parsed by the contract's own schema, which insists the path starts with
    // `/api/v1/` — so a path built by hand could not pass this.
    expect(messagesContract.startGeneration.response.parse(response.json())).toEqual({
      assistantMessageId: ANSWER,
      streamPath: `/api/v1/messages/${ANSWER}/stream`,
      resumed: false,
    });
    expect(startGeneration.execute).toHaveBeenCalledWith(
      { userId: ADA },
      {
        conversationId: ID,
        clientMessageId: ClientMessageId.trusted(CLIENT_ID),
        content: question.content,
      },
    );
  });

  it('says a repeat was resumed rather than starting a second answer', async () => {
    startGeneration.execute.mockResolvedValue(Ok({ assistantMessageId: ANSWER, resumed: true }));

    const response = await call('POST', url, question);

    expect(response.json()).toMatchObject({ resumed: true, assistantMessageId: ANSWER });
  });

  it('refuses a message the contract would not carry', async () => {
    const response = await call('POST', url, { content: '', clientMessageId: CLIENT_ID });

    expect(response.statusCode).toBe(400);
    expect(startGeneration.execute).not.toHaveBeenCalled();
  });

  it('refuses a client message id that is not one', async () => {
    const response = await call('POST', url, { content: 'hello', clientMessageId: 'not-a-uuid' });

    expect(response.statusCode).toBe(400);
    expect(startGeneration.execute).not.toHaveBeenCalled();
  });

  it('answers 404 for a conversation id that could not name one', async () => {
    const response = await call('POST', '/api/v1/conversations/nonsense/messages', question);

    expect(response.statusCode).toBe(404);
    expect(startGeneration.execute).not.toHaveBeenCalled();
  });

  it('answers 409 while an answer is already being written', async () => {
    startGeneration.execute.mockResolvedValue(Err(new ConflictError('already generating')));

    const response = await call('POST', url, question);

    expect(response.statusCode).toBe(409);
    // The wording is the filter's, so nothing about a constraint reaches anyone.
    expect(apiFailure.parse(response.json()).message).not.toContain('generating');
  });
});
