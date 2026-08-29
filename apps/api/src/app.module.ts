import { loadConfig, type AppConfig } from '@fca/config';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { APP_CONFIG } from './shared/config/app-config.token';
import { READINESS_TIMEOUT_MS } from './shared/health/health-indicator';
import { HealthController } from './shared/health/health.controller';
import { DomainErrorFilter } from './shared/http/domain-error.filter';
import { AppLogger, createPinoLogger } from './shared/observability/app-logger';
import { PersistenceModule } from './shared/persistence/persistence.module';

/**
 * The composition root. Every dependency is bound here by token, so nothing
 * constructs an adapter itself and nothing reaches into a container at runtime.
 * A test replaces a binding instead of booting the thing behind it.
 */
@Global()
@Module({
  imports: [PersistenceModule],
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
    { provide: READINESS_TIMEOUT_MS, useValue: 1_000 },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
  exports: [APP_CONFIG, AppLogger],
})
export class AppModule {}
