import { describe, expect, it, vi } from 'vitest';

import { TaskRegistry } from '../../../bootstrap/task-registry';
import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import type { ForgetFinishedJobs } from '../forget-finished-jobs';
import { OutboxJanitor } from '../outbox-janitor';

/**
 * The sweep itself is proven against a real database beside the relay. What is
 * left is the only thing this class adds: that one bad hour does not stop it.
 *
 * A janitor that dies on its first failure is one nobody notices has stopped —
 * nothing waits on it, so its absence looks exactly like its success.
 */

const silent = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

function janitorThat(forget: () => Promise<number>): OutboxJanitor {
  return new OutboxJanitor(
    { execute: forget } as unknown as ForgetFinishedJobs,
    new TaskRegistry(silent),
    silent,
  );
}

/** One round and then out, so the loop is exercised rather than the timer. */
async function oneRound(janitor: OutboxJanitor): Promise<void> {
  const controller = new AbortController();
  const looping = janitor.loop(controller.signal, 0);
  controller.abort();
  await looping;
}

describe('sweeping the outbox', () => {
  it('asks once per round', async () => {
    const forget = vi.fn(async () => await Promise.resolve(3));

    await oneRound(janitorThat(forget));

    expect(forget).toHaveBeenCalled();
  });

  it('carries on when a sweep fails, rather than ending the loop', async () => {
    const forget = vi.fn(async () => await Promise.reject(new Error('the database is gone')));

    // The assertion is the absence of a throw: an unhandled rejection here
    // would take the task registry's spawn down with it.
    await expect(oneRound(janitorThat(forget))).resolves.toBeUndefined();
    expect(forget).toHaveBeenCalled();
  });

  it('stops when it is told to, rather than on its own schedule', async () => {
    const forget = vi.fn(async () => await Promise.resolve(0));
    const janitor = janitorThat(forget);
    const controller = new AbortController();
    controller.abort();

    await janitor.loop(controller.signal, 60_000);

    // Aborted before the first round: shutdown waits for a sweep in progress
    // and cancels one that has not begun.
    expect(forget).not.toHaveBeenCalled();
  });
});
