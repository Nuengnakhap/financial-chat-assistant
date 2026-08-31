import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { DescribeUserUseCase } from '../../application/use-cases/describe-user.use-case';
import type { ListSessionsUseCase } from '../../application/use-cases/list-sessions.use-case';
import type { RevokeSessionUseCase } from '../../application/use-cases/revoke-session.use-case';
import type { RotateRefreshTokenUseCase } from '../../application/use-cases/rotate-refresh-token.use-case';
import type { SignOutUseCase } from '../../application/use-cases/sign-out.use-case';
import { callerFrom } from '../caller';
import { CurrentUserController } from '../current-user.controller';
import type { SessionCookies } from '../session-cookies';
import { SessionController } from '../session.controller';
import { SessionsController } from '../sessions.controller';

const request = (headers: Record<string, string | undefined>, ip = '203.0.113.7') =>
  ({ headers, ip }) as unknown as FastifyRequest;

describe('describing the caller', () => {
  it.each([
    [
      'Chrome on macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    ],
    [
      'Safari on iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
    ],
    [
      'Firefox on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    ],
    [
      'Edge on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
    ],
    [
      'Chrome on iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0.0.0 Mobile/15E148 Safari/604.1',
    ],
    [
      'Firefox on iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15',
    ],
  ])('names the browser and the system as "%s"', (expected, agent) => {
    // Edge says it is Chrome and Safari as well, and Chrome says it is Safari.
    // Every browser on iOS has to render with WebKit, so Chrome and Firefox
    // there say Safari too and are told apart only by CriOS/FxiOS. Reading the
    // list in order is what stops all five being called Safari.
    expect(callerFrom(request({ 'user-agent': agent })).device).toBe(expected);
  });

  it('keeps the system when the browser is one it has never heard of', () => {
    expect(callerFrom(request({ 'user-agent': 'SomeBot/1.0 (Linux)' })).device).toBe('Linux');
  });

  it.each([
    ['no user agent at all', {}],
    ['an empty one', { 'user-agent': '' }],
    ['one it recognises nothing in', { 'user-agent': 'curl/8.7.1' }],
  ])('falls back to a placeholder for %s', (_name, headers) => {
    // `chk_sessions_device_length` refuses a blank device, so this is what
    // stops a missing header from failing the insert.
    expect(callerFrom(request(headers)).device).toBe('Unknown device');
  });

  it('cannot be made to store a header of any length', () => {
    // The label comes from a fixed table, so an attacker-controlled header has
    // no way to reach `chk_sessions_device_length` at all.
    const caller = callerFrom(request({ 'user-agent': `${'x'.repeat(5_000)} Firefox/1.0` }));

    expect(caller.device).toBe('Firefox');
  });

  it('hashes the address and never carries it', () => {
    const caller = callerFrom(request({}, '203.0.113.7'));

    expect(caller.ipHash).toBe(createHash('sha256').update('203.0.113.7').digest('hex'));
    expect(caller.ipHash).not.toContain('203.0.113');
    // The column is a 64-character digest, and that is checked in the database.
    expect(caller.ipHash).toHaveLength(64);
  });

  it('gives two callers different hashes', () => {
    expect(callerFrom(request({}, '203.0.113.7')).ipHash).not.toBe(
      callerFrom(request({}, '198.51.100.4')).ipHash,
    );
  });
});

const sessionsController = () =>
  new SessionsController(
    { set: () => undefined, clear: () => undefined } as unknown as SessionCookies,
    { execute: () => Promise.resolve([]) } as unknown as ListSessionsUseCase,
    { execute: () => Promise.resolve(null) } as unknown as RevokeSessionUseCase,
  );

describe('a handler that runs without a guard', () => {
  it.each([
    [
      'reading the current user',
      async () =>
        await new CurrentUserController({
          execute: () => Promise.resolve(null),
        } as unknown as DescribeUserUseCase).me(),
    ],
    [
      'signing out',
      async () =>
        await new SessionController(
          { set: () => undefined, clear: () => undefined } as unknown as SessionCookies,
          { execute: () => Promise.resolve(null) } as unknown as RotateRefreshTokenUseCase,
          { execute: () => Promise.resolve(null) } as unknown as SignOutUseCase,
        ).logout({ clearCookie: () => undefined } as never),
    ],
    ['listing sessions', async () => await sessionsController().listSessions()],
    [
      'revoking a session',
      async () =>
        await sessionsController().revokeSession('01936d1e-8f7a-7c3e-b8d4-9a1e2f3b4c5d', {
          clearCookie: () => undefined,
        } as never),
    ],
  ])('fails loudly when %s finds no principal', async (_name, run) => {
    // Not a 401: the guard is what answers that. Reaching here with no
    // principal means the route was wired without one, which is a bug.
    await expect(run()).rejects.toThrow('SessionGuard did not record a principal');
  });
});
