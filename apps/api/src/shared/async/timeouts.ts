/**
 * Every timeout in the API goes through here. A `setTimeout` left running after
 * its promise settles keeps the event loop alive, which turns a clean shutdown
 * into a hang — so clearing the timer must not be something a caller remembers.
 */

interface Alarm {
  readonly rings: Promise<void>;
  cancel(): void;
}

/** The executor runs synchronously, so `cancel` is real by the time this returns. */
function alarm(timeoutMs: number): Alarm {
  let cancel = (): void => undefined;
  const rings = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    cancel = (): void => {
      clearTimeout(timer);
    };
  });
  return { rings, cancel };
}

/** Rejects if `work` has not settled in time. The label names the operation, not the failure. */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const timer = alarm(timeoutMs);
  const expiry = timer.rings.then<never>(() => {
    throw new Error(`${label} timed out after ${String(timeoutMs)}ms`);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    timer.cancel();
  }
}

/**
 * Whether `work` settled in time, however it settled. Used where the outcome is
 * already someone else's to report and only the waiting is in question.
 */
export async function settledWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timer = alarm(timeoutMs);

  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      timer.rings.then(() => false),
    ]);
  } finally {
    timer.cancel();
  }
}

export function delay(ms: number): Promise<void> {
  return alarm(ms).rings;
}

/**
 * Waits, unless cancellation arrives first — `false` means the caller was told
 * to stop and should not carry on round its loop. Every recurring task here
 * sleeps through this rather than through a bare `setTimeout`, so shutdown
 * never has to wait out an interval, and the timer is unreffed so a sleeping
 * task is never the reason the process stays alive.
 */
export async function sleepUnlessCancelled(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    timer.unref();

    function onAbort(): void {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
