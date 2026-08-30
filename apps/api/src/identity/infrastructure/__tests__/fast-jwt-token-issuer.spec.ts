import { createHmac } from 'node:crypto';

import type { AppConfig } from '@fca/config';
import { SessionId, UserId } from '@fca/domain';
import { describe, expect, it } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import { FastJwtTokenIssuer } from '../fast-jwt-token-issuer';

const USER = UserId.trusted('11111111-1111-4111-8111-111111111111');
const SESSION = SessionId.trusted('22222222-2222-4222-8222-222222222222');

function issuerWith(overrides: Partial<AppConfig['auth']> = {}): FastJwtTokenIssuer {
  const base = testConfig();
  return new FastJwtTokenIssuer({ ...base, auth: { ...base.auth, ...overrides } });
}

const issuer = issuerWith();

const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('an access token', () => {
  it('carries the user and the session it belongs to', () => {
    expect(
      issuer.verifyAccessToken(issuer.issueAccessToken({ userId: USER, sessionId: SESSION })),
    ).toEqual({ userId: USER, sessionId: SESSION });
  });

  it('is refused once it has expired', () => {
    const shortLived = issuerWith({ accessTokenTtlMs: 1 });
    const token = shortLived.issueAccessToken({ userId: USER, sessionId: SESSION });

    // fast-jwt compares against `exp` in whole seconds, so back-date instead of
    // sleeping: the claim is about expiry being enforced, not about timing.
    const expired = withPayload(token, { sub: USER, sid: SESSION, iat: 0, exp: 1 });

    expect(shortLived.verifyAccessToken(expired)).toBeNull();
  });

  it('is refused when signed with another key', () => {
    const other = issuerWith({ jwtSecret: 'y'.repeat(32) });

    expect(
      issuer.verifyAccessToken(other.issueAccessToken({ userId: USER, sessionId: SESSION })),
    ).toBeNull();
  });

  it('is refused when the payload was edited under the original signature', () => {
    const token = issuer.issueAccessToken({ userId: USER, sessionId: SESSION });
    const forged = withPayload(token, {
      sub: '99999999-9999-4999-8999-999999999999',
      sid: SESSION,
    });

    expect(issuer.verifyAccessToken(forged)).toBeNull();
  });

  it('is refused when the header claims no algorithm was used', () => {
    // The classic forgery: drop the signature and say none was needed.
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: USER, sid: SESSION })}.`;

    expect(issuer.verifyAccessToken(unsigned)).toBeNull();
  });

  it('is refused when the header names an algorithm we do not accept', () => {
    const header = encode({ alg: 'HS512', typ: 'JWT' });
    const payload = encode({ sub: USER, sid: SESSION, iat: 0, exp: 9_999_999_999 });
    const signature = createHmac('sha512', testConfig().auth.jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    expect(issuer.verifyAccessToken(`${header}.${payload}.${signature}`)).toBeNull();
  });

  it.each([
    ['not a token at all', 'hello'],
    ['an empty string', ''],
    ['too few segments', 'a.b'],
  ])('is refused when it is %s', (_label, token) => {
    expect(issuer.verifyAccessToken(token)).toBeNull();
  });

  it('is refused when the claims are the wrong shape, however well signed', () => {
    // A validly signed token is still not a principal if it says nothing about who.
    const noClaims = signedByIssuer({ iat: 0, exp: 9_999_999_999 });
    const notUuids = signedByIssuer({
      sub: 'someone',
      sid: 'somewhere',
      iat: 0,
      exp: 9_999_999_999,
    });

    expect(issuer.verifyAccessToken(noClaims)).toBeNull();
    expect(issuer.verifyAccessToken(notUuids)).toBeNull();
  });
});

describe('a refresh token', () => {
  it('is stored as a digest, never as itself', () => {
    const issued = issuer.issueRefreshToken();

    expect(issued.hash).not.toContain(issued.token);
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(issuer.hashRefreshToken(issued.token)).toBe(issued.hash);
  });

  it('is different every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => issuer.issueRefreshToken().token));

    expect(tokens.size).toBe(50);
  });

  it('carries at least 256 bits, so guessing one is not a strategy', () => {
    // base64url of 32 bytes, unpadded.
    expect(issuer.issueRefreshToken().token).toMatch(/^[\w-]{43}$/);
  });

  it('expires after the configured number of days', () => {
    const issued = issuerWith({ refreshTokenTtlDays: 30 }).issueRefreshToken();
    const days = (issued.expiresAt.getTime() - Date.now()) / 86_400_000;

    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });
});

/** Replaces the payload of a token, keeping the header and signature it came with. */
function withPayload(token: string, payload: object): string {
  const [header, , signature] = token.split('.');
  return `${String(header)}.${encode(payload)}.${String(signature)}`;
}

/** A token this issuer would accept the signature of, with claims we choose. */
function signedByIssuer(payload: object): string {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const signature = createHmac('sha256', testConfig().auth.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}
