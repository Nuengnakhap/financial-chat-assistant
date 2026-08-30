import { UnauthenticatedError, isErr, isOk } from '@fca/domain';
import { describe, expect, it, vi } from 'vitest';

import { fakeSessions, fakeTokens, fakeUnitOfWork, rotationOutcome } from './fakes';
import { testConfig } from '../../../shared/config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import type { RotationOutcome } from '../ports/session.repository';
import { SessionIssuer } from '../session-issuer';
import { RotateRefreshTokenUseCase } from '../use-cases/rotate-refresh-token.use-case';

const silent = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

function build(outcome: RotationOutcome) {
  const revokeFamily = vi.fn(() => Promise.resolve(1));
  const { uow, published } = fakeUnitOfWork({
    sessions: fakeSessions({ rotate: () => Promise.resolve(outcome), revokeFamily }),
  });
  const issuer = new SessionIssuer(fakeTokens(), testConfig());

  return { useCase: new RotateRefreshTokenUseCase(uow, issuer, silent), revokeFamily, published };
}

describe('rotating a refresh token', () => {
  it('hands back a new pair when the presented token was live', async () => {
    const { useCase, revokeFamily, published } = build(rotationOutcome.rotated());

    const result = await useCase.execute('presented');

    expect(isOk(result) && result.value.refreshToken).toBe('refresh-plaintext');
    expect(revokeFamily).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('cuts the lineage and records why, in one unit of work', async () => {
    const { useCase, revokeFamily, published } = build(rotationOutcome.reused());

    const result = await useCase.execute('presented');

    expect(isErr(result) && result.error).toBeInstanceOf(UnauthenticatedError);
    expect(revokeFamily).toHaveBeenCalledOnce();
    expect(published).toEqual([
      {
        aggregate: 'session',
        aggregateId: '01936d1e-8f7a-7c3e-b8d4-9a1e2f3b4c5d',
        type: 'session.token_reuse_detected',
        payload: { familyId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
      },
    ]);
  });

  it('leaves the lineage alone when two tabs merely raced', async () => {
    const { useCase, revokeFamily, published } = build(rotationOutcome.raced());

    const result = await useCase.execute('presented');

    // Failing this one request is the whole penalty; the other tab is still
    // signed in and so is every other device.
    expect(isErr(result)).toBe(true);
    expect(revokeFamily).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('says nothing about which token it was when it has never seen one', async () => {
    const { useCase, revokeFamily } = build(rotationOutcome.unknown());

    const result = await useCase.execute('presented');

    expect(isErr(result) && result.error.message).toBe('Session expired. Please sign in again.');
    expect(revokeFamily).not.toHaveBeenCalled();
  });

  it.each([
    ['reused', rotationOutcome.reused()],
    ['raced', rotationOutcome.raced()],
    ['unknown', rotationOutcome.unknown()],
  ])(
    'gives the same message for %s, so the difference cannot be probed',
    async (_name, outcome) => {
      const { useCase } = build(outcome);

      const result = await useCase.execute('presented');

      expect(isErr(result) && result.error.message).toBe('Session expired. Please sign in again.');
    },
  );
});
