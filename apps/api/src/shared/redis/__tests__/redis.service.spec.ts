import type { AppConfig } from '@fca/config';
import { describe, expect, it } from 'vitest';

import { testConfig } from '../../config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import { RedisService } from '../redis.service';

/**
 * Closing down when Redis is not there.
 *
 * No server, and that is the whole point — everything else about this class is
 * proven against a real one in `redis.service.int.spec.ts`. What cannot be
 * proven there is the case where the client never connected: `quit()` is a
 * command, so on a client that is still connecting, or reconnecting through an
 * outage, it waits for a connection that is not coming.
 *
 * It cost two suites and a day to notice. `create-app.spec.ts` and
 * `health.controller.spec.ts` boot the real module graph, and both passed
 * forever on a machine with `pnpm infra:up` running — then failed the first time
 * anything ran them without it, in `afterEach`, ten seconds at a time. The
 * README's promise that `pnpm test` needs no containers was untrue and nothing
 * said so. The same hang is a real one on `SIGTERM` during a Redis outage,
 * where every other step of the shutdown sequence is bounded.
 */

const NOTHING_LISTENS = 'redis://127.0.0.1:1';

function serviceFor(url: string): RedisService {
  const config: AppConfig = { ...testConfig(), redis: { url } };

  return new RedisService(
    config,
    new AppLogger(createPinoLogger({ level: 'silent', pretty: false })),
  );
}

describe('shutting down without a Redis to talk to', () => {
  it('returns at once when nothing was ever connected', async () => {
    const service = serviceFor(NOTHING_LISTENS);

    // Untouched: `lazyConnect` means no socket has been opened at all.
    await expect(service.onModuleDestroy()).resolves.toBe(undefined);
  });

  it('returns at once while a connection is still being attempted', async () => {
    const service = serviceFor(NOTHING_LISTENS);
    // One command is enough to start the attempt. It will fail; the failure is
    // not what this is about, so it is swallowed here rather than asserted.
    const attempt = service.check().catch(() => undefined);

    const started = Date.now();
    await service.onModuleDestroy();

    // Generous, because a machine under load is still a machine: what this
    // rules out is waiting for a connection, which never returns at all.
    expect(Date.now() - started).toBeLessThan(1_000);
    await attempt;
  }, 3_000);
});
