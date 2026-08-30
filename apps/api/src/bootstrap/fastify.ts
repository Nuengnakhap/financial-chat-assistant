import type { IncomingMessage } from 'node:http';

import { FastifyAdapter } from '@nestjs/platform-fastify';

import { runWithRequestContext, toRequestId } from '../shared/http/request-context';

/** Matches the 4,000-character question cap in the contracts, with room for envelope. */
const BODY_LIMIT_BYTES = 64 * 1024;

export function createFastifyAdapter(): FastifyAdapter {
  const adapter = new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,
    // Fastify's own id is replaced by ours so an inbound trace can continue.
    // Runs before Fastify builds its request object, so this is the raw one.
    genReqId: (request: IncomingMessage) => toRequestId(request.headers['x-request-id']),
  });

  adapter.getInstance().addHook('onRequest', (request, reply, done) => {
    const requestId = request.id;
    void reply.header('x-request-id', requestId);
    // Everything downstream — handlers, logs, the error filter — reads the id
    // from here rather than being handed it through every signature.
    runWithRequestContext({ requestId, principal: null }, done);
  });

  return adapter;
}
