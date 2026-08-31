import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

const UNKNOWN_DEVICE = 'Unknown device';

/**
 * Order matters, because a user agent claims to be several browsers at once:
 * Edge's contains "Chrome" and "Safari", Chrome's contains "Safari". The first
 * match down this list is the answer.
 *
 * The `iOS` tokens come first for the same reason and a stronger one: every
 * browser on iOS is required to render with WebKit, so Chrome and Firefox there
 * carry `Safari/` and nothing else distinguishes them from it.
 */
const BROWSERS: readonly (readonly [string, string])[] = [
  ['CriOS/', 'Chrome'],
  ['FxiOS/', 'Firefox'],
  ['EdgiOS/', 'Edge'],
  ['Edg/', 'Edge'],
  ['OPR/', 'Opera'],
  ['Chrome/', 'Chrome'],
  ['Firefox/', 'Firefox'],
  ['Safari/', 'Safari'],
];

const SYSTEMS: readonly (readonly [string, string])[] = [
  ['iPhone', 'iPhone'],
  ['iPad', 'iPad'],
  ['Android', 'Android'],
  ['Mac OS X', 'macOS'],
  ['Windows', 'Windows'],
  ['Linux', 'Linux'],
];

export interface Caller {
  /** What the session list shows, decided here so no client parses a header. */
  readonly device: string;
  /** A digest, never the address: it is shown in the session list and stored. */
  readonly ipHash: string;
}

/**
 * The edge is the last place that sees an address. Everything below is handed
 * the hash, so no log line, no Redis key and no table can hold one even by
 * accident.
 *
 * It is also the only place that sees a user agent, and what it stores is a
 * label rather than the header. "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
 * AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36" is not
 * an answer to "is that still me?"; "Chrome on macOS" is. Deciding it once, here,
 * is also what keeps the same guesswork out of the browser.
 */
export function callerFrom(request: FastifyRequest): Caller {
  const agent = request.headers['user-agent'];

  return {
    device: typeof agent === 'string' ? describe(agent) : UNKNOWN_DEVICE,
    ipHash: createHash('sha256').update(request.ip).digest('hex'),
  };
}

function describe(agent: string): string {
  const browser = BROWSERS.find(([token]) => agent.includes(token))?.[1];
  const system = SYSTEMS.find(([token]) => agent.includes(token))?.[1];

  if (browser === undefined) return system ?? UNKNOWN_DEVICE;
  return system === undefined ? browser : `${browser} on ${system}`;
}
