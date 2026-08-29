import { loadConfig, type AppConfig } from '@fca/config';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { HEALTH_INDICATORS, READINESS_TIMEOUT_MS } from './shared/health/health-indicator';
import { HealthController } from './shared/health/health.controller';
import { DomainErrorFilter } from './shared/http/domain-error.filter';
import { AppLogger, createPinoLogger } from './shared/observability/app-logger';

export const APP_CONFIG = Symbol('AppConfig');

/**
 * The composition root. Every dependency is bound here by token, so nothing
 * constructs an adapter itself and nothing reaches into a container at runtime.
 * A test replaces a binding instead of booting the thing behind it.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig(process.env) },
    {
      provide: AppLogger,
      useFactory: (config: AppConfig): AppLogger =>
        new AppLogger(
          createPinoLogger({
            level: config.nodeEnv === 'production' ? 'info' : 'debug',
            pretty: config.nodeEnv === 'development',
          }),
        ),
      inject: [APP_CONFIG],
    },
    // Nothing is a readiness dependency yet; persistence and Redis register here.
    { provide: HEALTH_INDICATORS, useValue: [] },
    { provide: READINESS_TIMEOUT_MS, useValue: 1_000 },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
  exports: [APP_CONFIG, AppLogger],
})
export class AppModule {}
