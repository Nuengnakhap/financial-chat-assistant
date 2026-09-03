import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { ReadinessProbe } from './readiness';
import { Counters } from '../observability/counters';

@Controller('healthz')
export class HealthController {
  constructor(
    private readonly readiness: ReadinessProbe,
    private readonly counters: Counters,
  ) {}

  /** Liveness: the process is running. Never touches a dependency, or a restart loop follows. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    // The reason stays out of the response: it names dependencies to anyone who
    // can reach the probe. It is in the log instead.
    if (!(await this.readiness.isReady())) throw new ServiceUnavailableException('Not ready');
    return { status: 'ok' };
  }

  /**
   * What this process has seen since it started. Counts only — a name from a
   * closed union and a label from a fixed set — so nothing here can be a value
   * somebody sent, and nothing here says what any question was about.
   *
   * On the health path rather than a `/metrics` of its own because that is
   * where somebody already looks when they want to know how a process is doing,
   * and because inventing an endpoint for a scraper that does not exist would
   * be building the half of observability that is furniture.
   */
  @Get('counters')
  counted(): Readonly<Record<string, number>> {
    return this.counters.snapshot();
  }
}
