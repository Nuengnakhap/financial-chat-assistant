import type { DomainErrorCode } from '@fca/domain';
import { z } from 'zod';

import { uuid } from '../primitives';

/**
 * What a client may receive when a request fails. Wider than `DomainErrorCode`
 * on purpose: the domain names business failures, and the transport adds the two
 * only it can have — a request that could not be read, and a bug.
 *
 * It lives here rather than in the API because both sides read it. A client that
 * declared its own copy would drift the moment a code was added, and the drift
 * would look like an unrecognised error rather than like a stale definition.
 */
export const apiErrorCode = z.enum([
  'validation',
  'unauthenticated',
  'invalid_credentials',
  'not_found',
  'conflict',
  'forbidden',
  'invalid_transition',
  'rate_limited',
  'budget_exceeded',
  'unverifiable',
  'bad_request',
  'internal',
]);

export const apiFailure = z.object({
  code: apiErrorCode,
  /** Written for a person to read. Never a developer message, never a stack. */
  message: z.string().min(1),
  requestId: uuid,
});

export type ApiErrorCode = z.infer<typeof apiErrorCode>;
export type ApiFailure = z.infer<typeof apiFailure>;

/**
 * Adding a code to the domain without adding it here would compile everywhere
 * and fail at the boundary, where the client would see an error it cannot name.
 * This makes it a build failure instead.
 */
type Assert<T extends true> = T;
type _EveryDomainCodeIsAnApiCode = Assert<DomainErrorCode extends ApiErrorCode ? true : false>;
