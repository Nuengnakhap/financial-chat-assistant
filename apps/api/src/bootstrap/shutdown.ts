import type { TaskRegistry } from './task-registry';
import { delay, settledWithin } from '../shared/async/timeouts';
import type { AppLogger } from '../shared/observability/app-logger';

/** How long a cut connection gets to unwind before the sequence stops waiting on it. */
const CUT_GRACE_MS = 1_000;

/** Only what the sequence needs from `ReadinessProbe`: the ability to stop saying yes. */
export interface Refusable {
  refuse(): void;
}

/** Only what the sequence needs from `SseStream`: the ability to let its readers go. */
export interface Windable {
  windDown(): Promise<void>;
}

export interface ShutdownTarget {
  /** Stops accepting connections and waits for the requests already in flight. */
  stopAcceptingRequests(): Promise<void>;
  /** Drops what is still open, so the wait above can end. */
  cutConnections(): void;
  /** Destroys the modules, which is where the pools and clients are released. */
  release(): Promise<void>;
}

export interface ShutdownTimings {
  /** Time for a router to act on the refused readiness probe before traffic is cut. */
  readonly readinessGraceMs: number;
  readonly connectionCloseTimeoutMs: number;
  readonly drainTimeoutMs: number;
}

export interface ShutdownDeps {
  readonly target: ShutdownTarget;
  readonly readiness: Refusable;
  readonly streams: Windable;
  readonly tasks: TaskRegistry;
  readonly logger: AppLogger;
  readonly timings: ShutdownTimings;
}

/**
 * Worst case is the sum of these plus the two grace periods the steps add of
 * their own: about 28 seconds, which is what keeps the whole sequence inside a
 * 30-second grace period rather than being cut off partway through it.
 */
export const DEFAULT_SHUTDOWN_TIMINGS: ShutdownTimings = {
  readinessGraceMs: 5_000,
  connectionCloseTimeoutMs: 5_000,
  drainTimeoutMs: 15_000,
};

/**
 * The order is the whole point: connections stop first, pools close last, and
 * background work finishes in between while it still has both. Nest runs
 * `onModuleDestroy` before it closes the server, so leaving the sequence to the
 * framework would tear down the database under requests still being served.
 *
 * Every step is bounded. A shutdown that any one client or task can hold open
 * forever gets killed partway through instead, which is the outcome the order
 * above exists to avoid.
 *
 * `release()` has no bound of its own on purpose: it destroys the modules, and
 * each `onModuleDestroy` is responsible for its own clock. That is not a
 * formality — both BullMQ connections retry forever because BullMQ requires it
 * to, so an unbounded `close()` there once made this last step wait for a Redis
 * that was never coming back. A module that can wait forever is a bug in that
 * module, and it is testable there without a shutdown around it.
 */
export async function runShutdown({
  target,
  readiness,
  streams,
  tasks,
  logger,
  timings,
}: ShutdownDeps): Promise<void> {
  logger.log('shutting down', { scope: 'Shutdown' });

  readiness.refuse();
  await delay(timings.readinessGraceMs);

  // Before the server stops accepting, not after: an event stream is a request
  // that never finishes on its own, so leaving them open would spend the whole
  // connection-close budget waiting for readers that are not going to leave —
  // and the steps that persist and settle come after that one.
  await streams.windDown();
  await closeConnections(target, timings.connectionCloseTimeoutMs, logger);
  await tasks.drain(timings.drainTimeoutMs);
  await target.release();

  logger.log('shutdown complete', { scope: 'Shutdown' });
}

/**
 * Wait, then cut — the same shape as draining a task, and for the same reason.
 * A request that never finishes (a stream, a client that stopped reading) would
 * otherwise keep the server closing forever, and the steps that release the
 * pools all come after this one.
 */
async function closeConnections(
  target: ShutdownTarget,
  timeoutMs: number,
  logger: AppLogger,
): Promise<void> {
  const closing = target.stopAcceptingRequests();
  if (await settledWithin(closing, timeoutMs)) return;

  logger.warn('cutting connections that outstayed the shutdown grace', { durationMs: timeoutMs });
  target.cutConnections();

  if (!(await settledWithin(closing, CUT_GRACE_MS))) {
    logger.error('the http server did not close; releasing resources anyway');
  }
}
