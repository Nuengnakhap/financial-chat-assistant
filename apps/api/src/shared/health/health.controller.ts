import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';

import {
  HEALTH_INDICATORS,
  READINESS_TIMEOUT_MS,
  checkAll,
  type HealthIndicator,
} from './health-indicator';
import { AppLogger } from '../observability/app-logger';

@Controller('healthz')
export class HealthController {
  constructor(
    @Inject(HEALTH_INDICATORS) private readonly indicators: readonly HealthIndicator[],
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
    private readonly logger: AppLogger,
  ) {}

  /** Liveness: the process is running. Never touches a dependency, or a restart loop follows. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    const failures = await checkAll(this.indicators, this.timeoutMs);
    if (failures.length > 0) {
      this.logger.warn(`not ready: ${failures.map((f) => `${f.name} (${f.reason})`).join(', ')}`);
      throw new ServiceUnavailableException('Not ready');
    }
    return { status: 'ok' };
  }
}
