import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { DescribeUserUseCase } from '../../application/use-cases/describe-user.use-case';
import type { RotateRefreshTokenUseCase } from '../../application/use-cases/rotate-refresh-token.use-case';
import type { SignOutUseCase } from '../../application/use-cases/sign-out.use-case';
import { callerFrom } from '../caller';
import { CurrentUserController } from '../current-user.controller';
import type { SessionCookies } from '../session-cookies';
import { SessionController } from '../session.controller';

const request = (headers: Record<string, string | undefined>, ip = '203.0.113.7') =>
  ({ headers, ip }) as unknown as FastifyRequest;

describe('describing the caller', () => {
  it('takes the device from the user agent', () => {
    expect(callerFrom(request({ 'user-agent': 'Firefox on macOS' })).device).toBe(
      'Firefox on macOS',
    );
  });

  it.each([
    ['no user agent at all', {}],
    ['an empty one', { 'user-agent': '' }],
    ['one that is only whitespace', { 'user-agent': '   ' }],
  ])('falls back to a placeholder for %s', (_name, headers) => {
    // `chk_sessions_device_length` refuses a blank device, so this is what
    // stops a missing header from failing the insert.
    expect(callerFrom(request(headers)).device).toBe('Unknown device');
  });

  it('truncates a device name to what the column accepts', () => {
    const caller = callerFrom(request({ 'user-agent': 'x'.repeat(500) }));

    expect(caller.device).toHaveLength(200);
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
  ])('fails loudly when %s finds no principal', async (_name, run) => {
    // Not a 401: the guard is what answers that. Reaching here with no
    // principal means the route was wired without one, which is a bug.
    await expect(run()).rejects.toThrow('SessionGuard did not record a principal');
  });
});
