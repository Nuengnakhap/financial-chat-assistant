import type { ApiErrorCode, ApiFailure } from '@fca/contracts';
import type { DomainErrorCode } from '@fca/domain';

/**
 * The envelope itself is defined in `@fca/contracts` because both sides read it.
 * What stays here is server behaviour: which status a code answers with, and the
 * wording a person sees.
 *
 * "Not signed in" is deliberately not a transport code: the identity context
 * owns that as `unauthenticated`, and two names for one 401 would make a client
 * switch on both.
 */
export type { ApiErrorCode, ApiFailure };

const STATUS_BY_CODE: Readonly<Record<DomainErrorCode, number>> = {
  validation: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_transition: 409,
  unverifiable: 422,
  rate_limited: 429,
  budget_exceeded: 429,
};

export function statusForDomainCode(code: DomainErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * A failure raised by the framework rather than the domain — an unmatched route,
 * a body too large to read — still answers with a code from this set, so a
 * client has one thing to switch on.
 */
export function codeForHttpStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
    case 413:
    case 415:
    case 422:
      return 'bad_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return 'internal';
  }
}

/**
 * Public wording per code. A domain error's own `message` names ids and tables
 * and stays in the log; the framework's own message is discarded for the same
 * reason. A user gets a sentence they can act on and nothing else.
 *
 * A table rather than a switch: there is no logic here, and keying it by the
 * union makes a missing entry a compile error without a `default` branch.
 */
const MESSAGE_BY_CODE: Readonly<Record<ApiErrorCode, string>> = {
  validation: 'The request could not be understood. Check the fields and try again.',
  bad_request: 'The request could not be read. Check the size and format of what you sent.',
  unauthenticated: 'You need to sign in to do that.',
  invalid_credentials: 'Email or password is incorrect.',
  forbidden: 'You do not have access to this.',
  not_found: 'That does not exist, or is no longer available.',
  conflict: 'That conflicts with the current state. Reload and try again.',
  invalid_transition: 'That conflicts with the current state. Reload and try again.',
  unverifiable: 'The answer could not be verified against the data, so it was not shown.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
  budget_exceeded: 'You have reached your usage limit for this period.',
  internal: 'Something went wrong on our side. Please try again.',
};

export function messageForCode(code: ApiErrorCode): string {
  return MESSAGE_BY_CODE[code];
}
