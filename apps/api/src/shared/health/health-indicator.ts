export interface HealthIndicator {
  readonly name: string;
  check(): Promise<void>;
}

/**
 * Readiness dependencies, registered by the modules that own them. Empty until
 * a module has something a request genuinely cannot proceed without — the
 * language model is deliberately not one of those, since reading history and
 * signing in keep working while a provider is down.
 */
export const HEALTH_INDICATORS = Symbol('HealthIndicators');

/** Injected so a test can shorten it, rather than making the suite wait on a clock. */
export const READINESS_TIMEOUT_MS = Symbol('ReadinessTimeoutMs');

export interface IndicatorFailure {
  readonly name: string;
  readonly reason: string;
}

export async function checkAll(
  indicators: readonly HealthIndicator[],
  timeoutMs: number,
): Promise<readonly IndicatorFailure[]> {
  // Pairing the name with its own check, rather than looking it up by index
  // afterwards, means there is no "unknown indicator" case to handle.
  const outcomes = await Promise.all(
    indicators.map((indicator) =>
      withTimeout(indicator, timeoutMs).then(
        () => null,
        (reason: unknown): IndicatorFailure => ({ name: indicator.name, reason: describe(reason) }),
      ),
    ),
  );

  return outcomes.filter((outcome) => outcome !== null);
}

/** A dependency that never answers is unavailable, not pending. */
async function withTimeout(indicator: HealthIndicator, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([indicator.check(), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
