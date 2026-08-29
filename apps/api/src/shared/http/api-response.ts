import type { DomainErrorCode } from '@fca/domain';

/**
 * What a client may receive. Wider than `DomainErrorCode` on purpose: the domain
 * describes business failures, and the transport adds the ones only it can have
 * — a request that could not be read, a caller that has not signed in, a bug.
 */
export type ApiErrorCode = DomainErrorCode | 'bad_request' | 'unauthorized' | 'internal';

/**
 * The failure half of the API envelope. The success half arrives with the first
 * endpoint that returns data — health probes answer a bare shape on purpose,
 * since they are read by infrastructure rather than by the app client.
 */
export interface ApiFailure {
  readonly code: ApiErrorCode;
  /** Written for a person to read. Never a developer message, never a stack. */
  readonly message: string;
  readonly requestId: string;
}

const STATUS_BY_CODE: Readonly<Record<DomainErrorCode, number>> = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_transition: 409,
  unverifiable: 422,
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
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
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
  unauthorized: 'You need to sign in to do that.',
  forbidden: 'You do not have access to this.',
  not_found: 'That does not exist, or is no longer available.',
  conflict: 'That conflicts with the current state. Reload and try again.',
  invalid_transition: 'That conflicts with the current state. Reload and try again.',
  unverifiable: 'The answer could not be verified against the data, so it was not shown.',
  budget_exceeded: 'You have reached your usage limit for this period.',
  internal: 'Something went wrong on our side. Please try again.',
};

export function messageForCode(code: ApiErrorCode): string {
  return MESSAGE_BY_CODE[code];
}
