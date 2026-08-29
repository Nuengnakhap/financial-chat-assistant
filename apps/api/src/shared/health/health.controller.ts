import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { ReadinessProbe } from './readiness';

@Controller('healthz')
export class HealthController {
  constructor(private readonly readiness: ReadinessProbe) {}

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
}
