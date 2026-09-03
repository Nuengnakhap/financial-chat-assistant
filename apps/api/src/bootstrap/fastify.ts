import type { IncomingMessage } from 'node:http';

import { FastifyAdapter } from '@nestjs/platform-fastify';

import { runWithRequestContext, toRequestId } from '../shared/http/request-context';

/** Matches the 4,000-character question cap in the contracts, with room for envelope. */
const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Set by hand rather than by installing `helmet`, which is a dependency and a
 * plugin for what is four headers on an API that answers JSON and SSE.
 *
 * `default-src 'none'` is the honest policy for this server: nothing it returns
 * is a document, so nothing it returns should be allowed to load anything.
 * `frame-ancestors 'none'` and `X-Frame-Options` say the same thing twice on
 * purpose — one for browsers that read CSP, one for the rest.
 *
 * `Strict-Transport-Security` is deliberately absent. It is a promise about TLS,
 * and the thing that knows whether TLS is on is the terminator in front of this
 * process — which does not exist here, because running locally is the whole of
 * the deployment story (`AGENTS.md`). Sending it over plain HTTP would be a
 * header that browsers ignore and that reads, to anyone auditing, as though the
 * question had been answered.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  // A JSON body that a browser decides to treat as HTML is the whole of the
  // content-sniffing class of bug.
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // A conversation id in a URL should not travel to whatever a page links to.
  'referrer-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

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
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) void reply.header(name, value);
    // Everything downstream — handlers, logs, the error filter — reads the id
    // from here rather than being handed it through every signature.
    runWithRequestContext({ requestId, principal: null }, done);
  });

  return adapter;
}
