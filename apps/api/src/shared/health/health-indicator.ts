import { withTimeout } from '../async/timeouts';

export interface HealthIndicator {
  readonly name: string;
  check(): Promise<void>;
}

/**
 * Readiness dependencies, listed once at the composition root. Two modules
 * providing this token would silently leave one list unused, and the language
 * model is deliberately absent: reading history and signing in keep working
 * while a provider is down.
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
      // A dependency that never answers is unavailable, not pending.
      withTimeout(indicator.check(), timeoutMs, 'check').then(
        () => null,
        (reason: unknown): IndicatorFailure => ({ name: indicator.name, reason: describe(reason) }),
      ),
    ),
  );

  return outcomes.filter((outcome) => outcome !== null);
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
