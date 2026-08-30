import fastifyCookie from '@fastify/cookie';
import { ConflictError, Err, Ok, RateLimitedError, UnauthenticatedError } from '@fca/domain';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFastifyAdapter } from '../../../bootstrap/fastify';
import { testConfig } from '../../../shared/config/__tests__/test-config';
import { APP_CONFIG } from '../../../shared/config/app-config.token';
import { DomainErrorFilter } from '../../../shared/http/domain-error.filter';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { storedUser } from '../../application/__tests__/fakes';
import { TOKEN_ISSUER } from '../../application/ports/token-issuer';
import { DescribeUserUseCase } from '../../application/use-cases/describe-user.use-case';
import { RegisterUserUseCase } from '../../application/use-cases/register-user.use-case';
import { RotateRefreshTokenUseCase } from '../../application/use-cases/rotate-refresh-token.use-case';
import { SignInUseCase } from '../../application/use-cases/sign-in.use-case';
import { SignOutUseCase } from '../../application/use-cases/sign-out.use-case';
import { CsrfGuard } from '../csrf.guard';
import { CurrentUserController } from '../current-user.controller';
import { RegistrationController } from '../registration.controller';
import { SessionCookies } from '../session-cookies';
import { SessionController } from '../session.controller';
import { SessionGuard } from '../session.guard';

const USER = storedUser();
const SESSION = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000),
};
const CREDENTIALS = {
  email: 'ada@example.com',
  password: 'correct-horse-battery',
  displayName: 'Ada',
};

const register = { execute: vi.fn() };
const signIn = { execute: vi.fn() };
const rotate = { execute: vi.fn() };
const signOut = { execute: vi.fn() };
const describeUser = { execute: vi.fn() };
const verifyAccessToken = vi.fn();

@Module({
  controllers: [RegistrationController, SessionController, CurrentUserController],
  providers: [
    { provide: APP_CONFIG, useValue: testConfig() },
    {
      provide: AppLogger,
      useValue: new AppLogger(createPinoLogger({ level: 'silent', pretty: false })),
    },
    { provide: RegisterUserUseCase, useValue: register },
    { provide: SignInUseCase, useValue: signIn },
    { provide: RotateRefreshTokenUseCase, useValue: rotate },
    { provide: SignOutUseCase, useValue: signOut },
    { provide: DescribeUserUseCase, useValue: describeUser },
    { provide: TOKEN_ISSUER, useValue: { verifyAccessToken } },
    SessionCookies,
    SessionGuard,
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
class AuthTestModule {}

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(AuthTestModule, createFastifyAdapter(), {
    logger: false,
  });
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.resetAllMocks();
});

interface Call {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: Payload;
  readonly cookies?: Record<string, string>;
  readonly headers?: Record<string, string>;
}

type Payload = NonNullable<InjectOptions['payload']>;

async function call(options: Call): Promise<LightMyRequestResponse> {
  // Built key by key: `exactOptionalPropertyTypes` refuses an explicit
  // `undefined` where the option is merely optional.
  const inject: InjectOptions = { method: options.method, url: options.url };
  if (options.payload !== undefined) inject.payload = options.payload;
  if (options.cookies !== undefined) inject.cookies = options.cookies;
  if (options.headers !== undefined) inject.headers = options.headers;

  return await app.getHttpAdapter().getInstance().inject(inject);
}

/** `set-cookie` may be one string or several; the tests only care about the set. */
const cookiesOf = (raw: string | string[] | undefined): string[] =>
  raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];

const cookieNamed = (raw: string | string[] | undefined, name: string): string | undefined =>
  cookiesOf(raw).find((cookie) => cookie.startsWith(`${name}=`));

describe('registering over HTTP', () => {
  it('answers 201 with the user and three cookies', async () => {
    register.execute.mockResolvedValue(Ok({ user: USER, session: SESSION }));

    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: CREDENTIALS,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      user: { ...USER, createdAt: USER.createdAt.toISOString() },
    });
    const set = response.headers['set-cookie'];
    expect(cookieNamed(set, 'fca_access')).toBeDefined();
    expect(cookieNamed(set, 'fca_refresh')).toBeDefined();
    expect(cookieNamed(set, 'fca_csrf')).toBeDefined();
  });

  it('never puts a token in the body', async () => {
    register.execute.mockResolvedValue(Ok({ user: USER, session: SESSION }));

    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: CREDENTIALS,
    });

    // A token in the body is a token any script on the page can read, which is
    // the whole reason they travel as httpOnly cookies.
    expect(response.body).not.toContain(SESSION.accessToken);
    expect(response.body).not.toContain(SESSION.refreshToken);
  });

  it('hides the session cookies from script and pins them to this site', async () => {
    register.execute.mockResolvedValue(Ok({ user: USER, session: SESSION }));

    const set = (await call({ method: 'POST', url: '/api/v1/auth/register', payload: CREDENTIALS }))
      .headers['set-cookie'];

    expect(cookieNamed(set, 'fca_access')).toContain('HttpOnly');
    expect(cookieNamed(set, 'fca_access')).toContain('SameSite=Strict');
    // The one the client must read to answer a CSRF challenge.
    expect(cookieNamed(set, 'fca_csrf')).not.toContain('HttpOnly');
  });

  it('keeps the refresh token off every path but the auth routes', async () => {
    register.execute.mockResolvedValue(Ok({ user: USER, session: SESSION }));

    const set = (await call({ method: 'POST', url: '/api/v1/auth/register', payload: CREDENTIALS }))
      .headers['set-cookie'];

    expect(cookieNamed(set, 'fca_refresh')).toContain('Path=/api/v1/auth');
    expect(cookieNamed(set, 'fca_access')).toContain('Path=/');
  });

  it.each([
    ['a password below the contract minimum', { ...CREDENTIALS, password: 'short' }],
    ['an address that is not one', { ...CREDENTIALS, email: 'not-an-address' }],
    ['a missing display name', { email: CREDENTIALS.email, password: CREDENTIALS.password }],
  ])('refuses %s with 400 and reaches no use case', async (_name, payload) => {
    const response = await call({ method: 'POST', url: '/api/v1/auth/register', payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation' });
    expect(register.execute).not.toHaveBeenCalled();
  });

  it('says nothing about what was sent when it refuses', async () => {
    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { ...CREDENTIALS, password: 'short' },
    });

    // The body of this route contains a password.
    expect(response.body).not.toContain('short');
  });

  it('reports a taken address as 409', async () => {
    register.execute.mockResolvedValue(Err(new ConflictError('Email already registered.')));

    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: CREDENTIALS,
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('signing in over HTTP', () => {
  it('answers 200 and starts a session', async () => {
    signIn.execute.mockResolvedValue(Ok({ user: USER, session: SESSION }));

    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: CREDENTIALS.email, password: CREDENTIALS.password },
    });

    expect(response.statusCode).toBe(200);
    expect(cookieNamed(response.headers['set-cookie'], 'fca_access')).toBeDefined();
  });

  it('passes a rate limit through with the wait attached', async () => {
    signIn.execute.mockResolvedValue(Err(new RateLimitedError('Too many attempts.', 42)));

    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: CREDENTIALS.email, password: CREDENTIALS.password },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('42');
  });

  it('tells a caller nothing about why the credentials failed', async () => {
    signIn.execute.mockResolvedValue(
      Err(new UnauthenticatedError('Email or password is incorrect.')),
    );

    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: CREDENTIALS.email, password: CREDENTIALS.password },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ message: 'You need to sign in to do that.' });
  });
});

describe('refreshing over HTTP', () => {
  it('rotates the cookies when the token is accepted', async () => {
    rotate.execute.mockResolvedValue(Ok({ ...SESSION, refreshToken: 'next-token' }));

    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { fca_refresh: 'presented', fca_csrf: 'token' },
      headers: { 'x-csrf-token': 'token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(cookieNamed(response.headers['set-cookie'], 'fca_refresh')).toContain('next-token');
  });

  it('clears the cookies when the token is refused', async () => {
    rotate.execute.mockResolvedValue(Err(new UnauthenticatedError('Session expired.')));

    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { fca_refresh: 'stolen', fca_csrf: 'token' },
      headers: { 'x-csrf-token': 'token' },
    });

    expect(response.statusCode).toBe(401);
    // A token we have refused is one the browser should stop sending.
    expect(cookieNamed(response.headers['set-cookie'], 'fca_refresh')).toContain('Expires=Thu, 01');
  });

  it('answers the same way when no token was presented at all', async () => {
    const response = await call({ method: 'POST', url: '/api/v1/auth/refresh' });

    expect(response.statusCode).toBe(401);
    expect(rotate.execute).not.toHaveBeenCalled();
  });
});

describe('the CSRF double submit', () => {
  it('lets a request with no session through, or nobody could sign in', async () => {
    signIn.execute.mockResolvedValue(Ok({ user: USER, session: SESSION }));

    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: CREDENTIALS.email, password: CREDENTIALS.password },
    });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['no header at all', undefined],
    ['a header that does not match the cookie', 'wrong-token'],
  ])('refuses a mutation carrying a session with %s', async (_name, header) => {
    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { fca_refresh: 'presented', fca_csrf: 'token' },
      headers: header === undefined ? {} : { 'x-csrf-token': header },
    });

    expect(response.statusCode).toBe(403);
    expect(rotate.execute).not.toHaveBeenCalled();
  });

  it('never challenges a read', async () => {
    verifyAccessToken.mockReturnValue({ userId: USER.id, sessionId: 'session' });
    describeUser.execute.mockResolvedValue(USER);

    const response = await call({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { fca_access: 'token', fca_csrf: 'token' },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('the current user', () => {
  it('needs a valid access token', async () => {
    verifyAccessToken.mockReturnValue(null);

    const response = await call({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { fca_access: 'expired' },
    });

    expect(response.statusCode).toBe(401);
    expect(describeUser.execute).not.toHaveBeenCalled();
  });

  it('answers 401 rather than 200 when the account has gone', async () => {
    verifyAccessToken.mockReturnValue({ userId: USER.id, sessionId: 'session' });
    describeUser.execute.mockResolvedValue(null);

    const response = await call({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { fca_access: 'token' },
    });

    // The token is signed rather than looked up, so it outlives the account.
    expect(response.statusCode).toBe(401);
  });

  it('reads the caller from the token, never from the request', async () => {
    verifyAccessToken.mockReturnValue({ userId: USER.id, sessionId: 'session' });
    describeUser.execute.mockResolvedValue(USER);

    await call({
      method: 'GET',
      url: '/api/v1/auth/me?userId=someone-else',
      cookies: { fca_access: 'token' },
    });

    expect(describeUser.execute).toHaveBeenCalledWith(USER.id);
  });
});

describe('signing out', () => {
  it('ends the session named by the token and clears every cookie', async () => {
    verifyAccessToken.mockReturnValue({ userId: USER.id, sessionId: 'session-id' });
    signOut.execute.mockResolvedValue(Ok(undefined));

    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { fca_access: 'token', fca_csrf: 'csrf' },
      headers: { 'x-csrf-token': 'csrf' },
    });

    expect(response.statusCode).toBe(200);
    expect(signOut.execute).toHaveBeenCalledWith(USER.id, 'session-id');
    expect(cookiesOf(response.headers['set-cookie'])).toHaveLength(3);
  });
});
