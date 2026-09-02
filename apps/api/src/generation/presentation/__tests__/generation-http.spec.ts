import fastifyCookie from '@fastify/cookie';
import { SESSION_COOKIE } from '@fca/contracts';
import { Err, MessageId, NotFoundError, Ok, SessionId, UserId } from '@fca/domain';
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
import { SseStream } from '../../../shared/http/sse-stream';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import type { StoredStreamEvent } from '../../application/ports/generation-events.port';
import { StopGenerationUseCase } from '../../application/use-cases/stop-generation.use-case';
import { WatchGenerationUseCase } from '../../application/use-cases/watch-generation.use-case';
import { GenerationController } from '../generation.controller';

/**
 * The two routes as they leave the server: the frames on the wire, the header a
 * browser sends by itself to resume, and the answers for a message that is not
 * the caller's.
 *
 * Only finished streams are injected. A live one never ends, and what happens
 * while it is running is proven where the events come from rather than here.
 */

const ADA = UserId.trusted('e5c9f4a1-1f0e-4a6a-9d4e-0c8b6a3f21d0');
const SESSION = SessionId.trusted('7c0be6ca-984d-40c9-93f6-a1d653f60210');
const ID = MessageId.trusted('a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d');

const watch = { execute: vi.fn() };
const stop = { execute: vi.fn() };
const verifyAccessToken = vi.fn();

@Module({
  controllers: [GenerationController],
  providers: [
    { provide: APP_CONFIG, useValue: testConfig() },
    {
      provide: AppLogger,
      useValue: new AppLogger(createPinoLogger({ level: 'silent', pretty: false })),
    },
    { provide: WatchGenerationUseCase, useValue: watch },
    { provide: StopGenerationUseCase, useValue: stop },
    { provide: ACCESS_TOKEN_VERIFIER, useValue: { verifyAccessToken } },
    SseStream,
    SessionGuard,
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
class GenerationTestModule {}

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(
    GenerationTestModule,
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
  stop.execute.mockResolvedValue(Ok(undefined));
});

async function call(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string | string[]> = {},
): Promise<LightMyRequestResponse> {
  const inject: InjectOptions = {
    method,
    url,
    headers,
    cookies: { [SESSION_COOKIE.access]: 'a-token' },
  };

  return await app.getHttpAdapter().getInstance().inject(inject);
}

const streamOf = (...events: StoredStreamEvent[]): void => {
  watch.execute.mockResolvedValue(Ok(events));
};

const done: StoredStreamEvent = {
  id: '2-0',
  event: { type: 'error', code: 'generation_failed', message: 'Something went wrong.' },
};

describe('watching a generation', () => {
  it('answers as an event stream, unbuffered by anything in the way', async () => {
    streamOf(done);

    const response = await call('GET', `/api/v1/messages/${ID}/stream`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    // A proxy that compresses buffers, and a buffered event stream arrives all
    // at once at the end — which is not a stream.
    expect(response.headers['cache-control']).toBe('no-cache, no-transform');
    expect(response.headers['x-accel-buffering']).toBe('no');
  });

  it('writes each event with the id a client would come back with', async () => {
    streamOf({ id: '1-0', event: { type: 'text_delta', delta: 'Apple' } }, done);

    const body = (await call('GET', `/api/v1/messages/${ID}/stream`)).body;

    expect(body).toContain('id: 1-0\ndata: {"type":"text_delta","delta":"Apple"}\n\n');
    expect(body).toContain('id: 2-0\n');
  });

  it('writes no id for an event the server made up', async () => {
    streamOf({ id: null, event: { type: 'reconnect_hint' } });

    const body = (await call('GET', `/api/v1/messages/${ID}/stream`)).body;

    // An id here would move the client's cursor to a position that does not
    // exist, and it would resume from the wrong place.
    expect(body).toContain('data: {"type":"reconnect_hint"}');
    expect(body).not.toContain('id:');
  });

  it('resumes from the header the browser sends by itself', async () => {
    streamOf(done);

    await call('GET', `/api/v1/messages/${ID}/stream`, { 'last-event-id': '42-1' });

    expect(watch.execute).toHaveBeenCalledWith(
      { userId: ADA },
      ID,
      expect.objectContaining({ afterId: '42-1' }),
    );
  });

  it.each([
    ['nothing at all', {}],
    ['an empty header', { 'last-event-id': '' }],
    ['something that is not a position', { 'last-event-id': 'nonsense' }],
    // Two copies of the header, folded into one value by whatever was in the
    // way. Passed on, it would reach Redis as a malformed range and fail in the
    // middle of a response that had already begun.
    ['the header twice', { 'last-event-id': ['42-1', '7-0'] }],
  ])('starts from the beginning when the client sends %s', async (_name, headers) => {
    streamOf(done);

    await call('GET', `/api/v1/messages/${ID}/stream`, headers);

    expect(watch.execute).toHaveBeenCalledWith(
      { userId: ADA },
      ID,
      expect.objectContaining({ afterId: '0-0' }),
    );
  });

  it('answers 404 with a status, because nothing has been written yet', async () => {
    watch.execute.mockResolvedValue(Err(new NotFoundError('gone')));

    const response = await call('GET', `/api/v1/messages/${ID}/stream`);

    // Once a stream is open a failure can only travel as an event. Before the
    // first byte it is still an ordinary response, and this is where the check
    // that it is the caller's message belongs.
    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for an id that could not name a message', async () => {
    const response = await call('GET', '/api/v1/messages/nonsense/stream');

    expect(response.statusCode).toBe(404);
    expect(watch.execute).not.toHaveBeenCalled();
  });
});

describe('stopping a generation', () => {
  it('answers 202, because the writing is happening somewhere else', async () => {
    const response = await call('POST', `/api/v1/messages/${ID}/stop`);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(stop.execute).toHaveBeenCalledWith({ userId: ADA }, ID);
  });

  it('answers 404 for a message that is not the caller to stop', async () => {
    stop.execute.mockResolvedValue(Err(new NotFoundError('gone')));

    expect((await call('POST', `/api/v1/messages/${ID}/stop`)).statusCode).toBe(404);
  });
});

describe('both routes', () => {
  it('refuse everyone who is not signed in', async () => {
    verifyAccessToken.mockReturnValue(null);

    const answers = await Promise.all([
      call('GET', `/api/v1/messages/${ID}/stream`),
      call('POST', `/api/v1/messages/${ID}/stop`),
    ]);

    expect(answers.map((response) => response.statusCode)).toEqual([401, 401]);
    expect(watch.execute).not.toHaveBeenCalled();
    expect(stop.execute).not.toHaveBeenCalled();
  });
});
