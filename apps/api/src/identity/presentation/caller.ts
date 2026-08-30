import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

/** `chk_sessions_device_length` allows 1..200, and a header is attacker-controlled. */
const MAX_DEVICE = 200;
const UNKNOWN_DEVICE = 'Unknown device';

export interface Caller {
  readonly device: string;
  /** A digest, never the address: it is shown in the session list and stored. */
  readonly ipHash: string;
}

/**
 * The edge is the last place that sees an address. Everything below is handed
 * the hash, so no log line, no Redis key and no table can hold one even by
 * accident.
 */
export function callerFrom(request: FastifyRequest): Caller {
  const agent = request.headers['user-agent'];
  const device = typeof agent === 'string' ? agent.trim().slice(0, MAX_DEVICE) : '';

  return {
    device: device === '' ? UNKNOWN_DEVICE : device,
    ipHash: createHash('sha256').update(request.ip).digest('hex'),
  };
}
