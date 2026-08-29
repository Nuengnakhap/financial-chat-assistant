import { Inject, Injectable } from '@nestjs/common';

import {
  HEALTH_INDICATORS,
  READINESS_TIMEOUT_MS,
  checkAll,
  type HealthIndicator,
} from './health-indicator';
import { AppLogger } from '../observability/app-logger';

/**
 * Whether this process should be sent traffic. Refusing is a decision the
 * shutdown sequence makes before anything is torn down, so traffic has
 * somewhere else to go while in-flight work finishes — the dependencies are
 * still perfectly healthy at that point, which is why asking them is not enough.
 */
@Injectable()
export class ReadinessProbe {
  private accepting = true;

  constructor(
    @Inject(HEALTH_INDICATORS) private readonly indicators: readonly HealthIndicator[],
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
    private readonly logger: AppLogger,
  ) {}

  refuse(): void {
    this.accepting = false;
  }

  async isReady(): Promise<boolean> {
    if (!this.accepting) return false;

    const failures = await checkAll(this.indicators, this.timeoutMs);
    if (failures.length === 0) return true;

    this.logger.warn(`not ready: ${failures.map((f) => `${f.name} (${f.reason})`).join(', ')}`);
    return false;
  }
}
