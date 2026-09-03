import { createServer, type Server, type Socket } from 'node:net';

import type { AppConfig } from '@fca/config';
import { afterEach, describe, expect, it } from 'vitest';

import { delay } from '../../async/timeouts';
import { testConfig } from '../../config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import { BullMqOutboxPublisher } from '../bullmq-outbox-publisher';
import { DomainEventWorker } from '../domain-event-worker';

/**
 * Shutting down while Redis is not there.
 *
 * BullMQ needs `maxRetriesPerRequest: null` — a worker's blocking read is meant
 * to sit for minutes — and that setting is exactly why `close()` cannot fail:
 * it retries forever, so with nothing listening it never returns. Both closes
 * are awaited in `onModuleDestroy`, which is the last step of the shutdown
 * sequence and the only one that was not bounded.
 *
 * Found the expensive way. `create-app.spec.ts` and `health.controller.spec.ts`
 * boot the real module graph and had passed for weeks on a machine where
 * `pnpm infra:up` was running; the first run without it — a Linux container
 * standing in for CI — failed both, ten seconds at a time, in a teardown hook.
 * The README's claim that `pnpm test` needs no containers had been untrue for
 * as long as it had been written down.
 *
 * No server on purpose: what is proven here is the case where there is none.
 */

const NOTHING_LISTENS = 'redis://127.0.0.1:1';

function config(url = NOTHING_LISTENS): AppConfig {
  return { ...testConfig(), redis: { url } };
}

/**
 * A socket that accepts and then says nothing — the shape of an outage that a
 * refused connection does not cover, and the one that actually hangs. A refused
 * connection fails fast; a server that answers the handshake and then goes
 * quiet leaves every command waiting for a reply, which with
 * `maxRetriesPerRequest: null` is forever.
 */
let silentRedis: Server | undefined;
const accepted = new Set<Socket>();

async function listenSilently(): Promise<string> {
  const server = createServer((socket) => {
    // Accept, hold, answer nothing. Kept so the teardown can drop it: a
    // `net.Server` waits for every socket it accepted, and the client on the
    // other end is in no hurry to leave.
    accepted.add(socket);
    socket.on('close', () => accepted.delete(socket));
  });
  silentRedis = server;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was allocated');

  return `redis://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  const server = silentRedis;
  silentRedis = undefined;
  if (server === undefined) return;
  // `close()` waits for every open socket, and a client that has been dropped
  // may still be holding one — or reconnecting into a new one. Dropping them
  // from this side is what makes the teardown bounded rather than hopeful.
  for (const socket of accepted) socket.destroy();
  accepted.clear();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const silent = (): AppLogger => new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

/** Generous against a loaded machine; what it rules out is not returning at all. */
const BOUND_MS = 8_000;

describe('the domain event worker', () => {
  it('closes rather than waiting for a Redis that is not answering', async () => {
    const worker = new DomainEventWorker(config(), [], silent());
    worker.onApplicationBootstrap();

    const started = Date.now();
    await worker.onModuleDestroy();

    expect(Date.now() - started).toBeLessThan(BOUND_MS);
  }, 20_000);

  it('closes even when the socket is open and Redis has stopped answering', async () => {
    // The case a refused connection cannot show: connected, and no reply ever.
    const worker = new DomainEventWorker(config(await listenSilently()), [], silent());
    worker.onApplicationBootstrap();
    // Long enough for the worker to have started waiting on a reply, which is
    // what `close()` then has to wait for. Closing before it ever asked
    // anything proves nothing.
    await delay(2_500);

    const started = Date.now();
    await worker.onModuleDestroy();

    expect(Date.now() - started).toBeLessThan(BOUND_MS);
  }, 30_000);

  it('closes when it was never started, without pretending it was', async () => {
    const worker = new DomainEventWorker(config(), [], silent());

    await expect(worker.onModuleDestroy()).resolves.toBe(undefined);
  });
});

describe('the outbox publisher', () => {
  it('closes rather than waiting for a Redis that is not answering', async () => {
    const publisher = new BullMqOutboxPublisher(config(), silent());

    const started = Date.now();
    await publisher.onModuleDestroy();

    expect(Date.now() - started).toBeLessThan(BOUND_MS);
  }, 20_000);

  it('closes even when the socket is open and Redis has stopped answering', async () => {
    const publisher = new BullMqOutboxPublisher(config(await listenSilently()), silent());
    // A write in flight against a server that will not answer it. Deliberately
    // not awaited anywhere: with `maxRetriesPerRequest: null` this promise can
    // never settle, which is the whole point — the close must not wait for it.
    void publisher.publish([]).catch(() => undefined);
    await delay(500);

    const started = Date.now();
    await publisher.onModuleDestroy();

    expect(Date.now() - started).toBeLessThan(BOUND_MS);
  }, 30_000);
});
