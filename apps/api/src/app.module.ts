import { loadConfig, type AppConfig } from '@fca/config';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { TaskRegistry } from './bootstrap/task-registry';
import { IdentityModule } from './identity/identity.module';
import { APP_CONFIG } from './shared/config/app-config.token';
import { CpuModule } from './shared/cpu/cpu.module';
import { HEALTH_INDICATORS, READINESS_TIMEOUT_MS } from './shared/health/health-indicator';
import { HealthController } from './shared/health/health.controller';
import { ReadinessProbe } from './shared/health/readiness';
import { DomainErrorFilter } from './shared/http/domain-error.filter';
import { AppLogger, createPinoLogger } from './shared/observability/app-logger';
import { DatabaseService } from './shared/persistence/database.service';
import { PersistenceModule } from './shared/persistence/persistence.module';
import { RedisModule } from './shared/redis/redis.module';
import { RedisService } from './shared/redis/redis.service';

/**
 * The composition root. Every dependency is bound here by token, so nothing
 * constructs an adapter itself and nothing reaches into a container at runtime.
 * A test replaces a binding instead of booting the thing behind it.
 */
@Global()
@Module({
  imports: [PersistenceModule, RedisModule, CpuModule, IdentityModule],
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
    ReadinessProbe,
    TaskRegistry,
    // What "ready" means, stated in one place: a request cannot be served
    // without either of these. Listing them here rather than letting each module
    // provide the token is what stops a second list from silently replacing the first.
    {
      provide: HEALTH_INDICATORS,
      useFactory: (database: DatabaseService, redis: RedisService) => [database, redis],
      inject: [DatabaseService, RedisService],
    },
    { provide: READINESS_TIMEOUT_MS, useValue: 1_000 },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
  exports: [APP_CONFIG, AppLogger, ReadinessProbe, TaskRegistry],
})
export class AppModule {}
