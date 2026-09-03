import {
  BudgetExceededError,
  ConflictError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
  UnverifiableClaimError,
  ValidationError,
  type DomainError,
  type DomainErrorCode,
} from '@fca/domain';
import { Body, Controller, Get, Module, Post, UnauthorizedException } from '@nestjs/common';
import { NestFactory, APP_FILTER } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFastifyAdapter } from '../../../bootstrap/fastify';
import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import { messageForCode } from '../api-response';
import { DomainErrorFilter } from '../domain-error.filter';

const DEVELOPER_MESSAGE = 'conversation 0e1f is owned by another user, internals table row 42';

/** One route per failure the filter has to translate. */
@Controller('boom')
class BoomController {
  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }

  @Get('unauthorized')
  unauthorized(): never {
    throw new UnauthorizedException('jwt signature mismatch for key kid-7');
  }

  @Get('validation')
  validation(): never {
    throw new ValidationError(DEVELOPER_MESSAGE, { field: 'content' });
  }
  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenError(DEVELOPER_MESSAGE);
  }
  @Get('not-found')
  notFound(): never {
    throw new NotFoundError(DEVELOPER_MESSAGE);
  }
  @Get('conflict')
  conflict(): never {
    throw new ConflictError(DEVELOPER_MESSAGE);
  }
  @Get('transition')
  transition(): never {
    throw new InvalidTransitionError(DEVELOPER_MESSAGE);
  }
  @Get('unverifiable')
  unverifiable(): never {
    throw new UnverifiableClaimError(DEVELOPER_MESSAGE);
  }
  @Get('unauthenticated')
  unauthenticated(): never {
    throw new UnauthenticatedError(DEVELOPER_MESSAGE);
  }
  @Get('rate-limited')
  rateLimited(): never {
    throw new RateLimitedError(DEVELOPER_MESSAGE, 300, { scope: 'email' });
  }
  @Get('budget')
  budget(): never {
    throw new BudgetExceededError(DEVELOPER_MESSAGE);
  }
  @Get('bug')
  bug(): never {
    throw new TypeError('cannot read properties of undefined (reading secretToken)');
  }

  @Get('thrown-string')
  thrownString(): never {
    // Not everything thrown is an Error; a rejected string still has to answer.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw 'raw string with secretToken inside';
  }
}

@Module({
  controllers: [BoomController],
  providers: [
    {
      provide: AppLogger,
      useValue: new AppLogger(createPinoLogger({ level: 'silent', pretty: false })),
    },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
class BoomModule {}

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(BoomModule, createFastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

const call = async (path: string) =>
  await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: path });

describe('a domain failure becomes the status its code implies', () => {
  it.each([
    ['/boom/validation', 400, 'validation'],
    ['/boom/unauthenticated', 401, 'unauthenticated'],
    ['/boom/forbidden', 403, 'forbidden'],
    ['/boom/not-found', 404, 'not_found'],
    ['/boom/conflict', 409, 'conflict'],
    ['/boom/transition', 409, 'invalid_transition'],
    ['/boom/unverifiable', 422, 'unverifiable'],
    ['/boom/rate-limited', 429, 'rate_limited'],
    ['/boom/budget', 429, 'budget_exceeded'],
  ])('%s answers %i with code %s', async (path, status, code) => {
    const response = await call(path);

    expect(response.statusCode).toBe(status);
    expect(response.json<{ code: DomainErrorCode }>().code).toBe(code);
  });
});

describe('nothing about how the server is built reaches the caller', () => {
  it.each([
    '/boom/validation',
    '/boom/forbidden',
    '/boom/not-found',
    '/boom/conflict',
    '/boom/transition',
    '/boom/unverifiable',
    '/boom/budget',
  ])('%s replaces the developer message with public wording', async (path) => {
    const body = await call(path).then((r) => r.body);

    expect(body).not.toContain(DEVELOPER_MESSAGE);
    expect(body).not.toContain('internals table');
    expect(body).not.toContain('Error');
  });

  it('turns an unexpected bug into a generic 500 with no stack', async () => {
    const response = await call('/boom/bug');

    expect(response.statusCode).toBe(500);
    expect(response.json<{ code: string; message: string }>()).toMatchObject({
      code: 'internal',
      message: messageForCode('internal'),
    });
    expect(response.body).not.toContain('secretToken');
    expect(response.body).not.toContain('TypeError');
    expect(response.body).not.toContain('at ');
  });
});

describe('anything at all can be thrown', () => {
  it('answers a thrown string as a generic 500, keeping its text out', async () => {
    const response = await call('/boom/thrown-string');

    expect(response.statusCode).toBe(500);
    expect(response.json<{ code: string }>().code).toBe('internal');
    expect(response.body).not.toContain('secretToken');
  });
});

describe('a rate limit tells the caller how long to wait', () => {
  it('sends Retry-After, which is the one detail wording cannot carry', async () => {
    const response = await call('/boom/rate-limited');

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('300');
  });

  it('still says nothing about which limit was hit', async () => {
    const response = await call('/boom/rate-limited');

    expect(response.body).not.toContain('email');
    expect(response.body).not.toContain(DEVELOPER_MESSAGE);
  });

  it('does not send Retry-After for a failure that has no wait', async () => {
    // A spent budget answers 429 too; suggesting a retry after 300 seconds
    // would be wrong, because the window has not moved.
    expect((await call('/boom/budget')).headers['retry-after']).toBeUndefined();
  });
});

/**
 * Set by hand rather than by a plugin, so they are checked by hand too. Four
 * headers on an API that answers JSON and SSE, and one of them is here twice on
 * purpose — for browsers that read CSP and for the rest.
 */
describe('the headers every response carries', () => {
  it('says a browser may load nothing at all from what this returns', async () => {
    const { headers } = await call('/boom/not-found');

    expect(headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
  });

  it('says a JSON body is a JSON body, whatever a browser guesses', async () => {
    expect((await call('/boom/not-found')).headers['x-content-type-options']).toBe('nosniff');
  });

  it('keeps a conversation id out of the referrer of whatever a page links to', async () => {
    expect((await call('/boom/not-found')).headers['referrer-policy']).toBe('same-origin');
  });

  it('does not promise anything about TLS it is in no position to know', async () => {
    // `Strict-Transport-Security` belongs to the terminator in front of this
    // process, which is the thing that knows whether TLS is on. Sent from here
    // over plain HTTP it is ignored by browsers and reads, to anyone auditing,
    // as though the question had been answered.
    expect((await call('/boom/not-found')).headers['strict-transport-security']).toBeUndefined();
  });
});

describe('correlation', () => {
  it('returns the request id in both the header and the body', async () => {
    const response = await call('/boom/not-found');

    const requestId = response.json<{ requestId: string }>().requestId;
    expect(requestId).not.toBe('no-request');
    expect(response.headers['x-request-id']).toBe(requestId);
  });

  it('continues an inbound trace instead of starting a new one', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/boom/not-found', headers: { 'x-request-id': 'trace-abc' } });

    expect(response.json<{ requestId: string }>().requestId).toBe('trace-abc');
  });

  it('refuses a forged request id rather than echoing it into the logs', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/boom/not-found',
        headers: { 'x-request-id': 'trace\n injected=line' },
      });

    expect(response.json<{ requestId: string }>().requestId).not.toContain('injected');
  });
});

describe('a framework failure answers from the same closed set of codes', () => {
  it('labels an unmatched route not_found, not internal', async () => {
    const response = await call('/no-such-route');

    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('not_found');
  });

  it('still carries a request id, so an unmatched route is traceable', async () => {
    const response = await call('/no-such-route');

    expect(response.json<{ requestId: string }>().requestId).toBe(response.headers['x-request-id']);
  });
});

describe('a framework failure never speaks in the framework voice', () => {
  it('answers an unauthorized request with our own wording', async () => {
    const response = await call('/boom/unauthorized');

    expect(response.statusCode).toBe(401);
    // The same code the domain uses for 401: a client switches on one name,
    // whether the refusal came from a guard or from deep inside the framework.
    expect(response.json<{ code: string }>().code).toBe('unauthenticated');
    // Nest would otherwise forward "jwt signature mismatch for key kid-7".
    expect(response.body).not.toContain('jwt');
    expect(response.body).not.toContain('kid-7');
  });

  it('answers an oversized body as a client mistake, not a server bug', async () => {
    // Fastify rejects this in its content parser, before any handler runs. It
    // reaches the filter as an HttpException, so the envelope holds — but the
    // status has no domain code, which is how it used to answer 'internal'.
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/boom/echo',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ x: 'y'.repeat(70_000) }),
      });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ code: string }>().code).toBe('bad_request');
  });

  it('answers a malformed body the same way', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/boom/echo',
        headers: { 'content-type': 'application/json' },
        payload: '{ not json',
      });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('bad_request');
  });
});

describe('the error taxonomy is covered', () => {
  it('maps every code the domain can produce', () => {
    // A new code added to the union makes statusForDomainCode fail to compile
    // via assertNever; this catches the other half — a code with no route here.
    const errors: readonly DomainError[] = [
      new ValidationError('x'),
      new UnauthenticatedError('x'),
      new ForbiddenError('x'),
      new NotFoundError('x'),
      new ConflictError('x'),
      new InvalidTransitionError('x'),
      new UnverifiableClaimError('x'),
      new RateLimitedError('x', 1),
      new BudgetExceededError('x'),
    ];

    expect(new Set(errors.map((error) => error.code)).size).toBe(9);
  });
});
