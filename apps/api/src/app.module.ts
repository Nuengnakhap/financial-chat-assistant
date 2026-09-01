import { loadConfig, type AppConfig } from '@fca/config';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { TaskRegistry } from './bootstrap/task-registry';
import { ConversationModule } from './conversation/conversation.module';
import { ConversationDeletionSubscriber } from './conversation/infrastructure/conversation-deletion.subscriber';
import { GenerationModule } from './generation/generation.module';
import { IdentityModule } from './identity/identity.module';
import { APP_CONFIG } from './shared/config/app-config.token';
import { CpuModule } from './shared/cpu/cpu.module';
import { FinancialQueryPool } from './shared/financial/financial-query.pool';
import { FinancialModule } from './shared/financial/financial.module';
import { HEALTH_INDICATORS, READINESS_TIMEOUT_MS } from './shared/health/health-indicator';
import { HealthController } from './shared/health/health.controller';
import { ReadinessProbe } from './shared/health/readiness';
import { DomainErrorFilter } from './shared/http/domain-error.filter';
import { AppLogger, createPinoLogger } from './shared/observability/app-logger';
import { DatabaseService } from './shared/persistence/database.service';
import { PersistenceModule } from './shared/persistence/persistence.module';
import { DOMAIN_EVENT_HANDLERS, type DomainEventHandler } from './shared/queue/domain-events';
import { QueueModule } from './shared/queue/queue.module';
import { RedisModule } from './shared/redis/redis.module';
import { RedisService } from './shared/redis/redis.service';

/**
 * The composition root. Every dependency is bound here by token, so nothing
 * constructs an adapter itself and nothing reaches into a container at runtime.
 * A test replaces a binding instead of booting the thing behind it.
 */
@Global()
@Module({
  imports: [
    PersistenceModule,
    RedisModule,
    // Imported here as well as by the context that queries through it, because
    // readiness below asks it a question and a factory can only inject what its
    // own module can see.
    FinancialModule,
    CpuModule,
    IdentityModule,
    ConversationModule,
    GenerationModule,
    QueueModule,
  ],
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
    // without any of these. Listing them here rather than letting each module
    // provide the token is what stops a second list from silently replacing the
    // first. The financial connection is a third one rather than a duplicate of
    // the first: it is the same server but a different role, and a password or a
    // grant that is wrong for `llm_reader` is invisible to the other check until
    // somebody asks a question.
    {
      provide: HEALTH_INDICATORS,
      useFactory: (
        database: DatabaseService,
        redis: RedisService,
        financial: FinancialQueryPool,
      ) => [database, redis, financial],
      inject: [DatabaseService, RedisService, FinancialQueryPool],
    },
    { provide: READINESS_TIMEOUT_MS, useValue: 1_000 },
    // Who consumes which domain event, stated in one place for the same reason
    // the readiness list is: a second list contributed by a module would
    // silently replace this one rather than add to it.
    {
      provide: DOMAIN_EVENT_HANDLERS,
      useFactory: (deletion: ConversationDeletionSubscriber): readonly DomainEventHandler[] => [
        deletion,
      ],
      inject: [ConversationDeletionSubscriber],
    },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
  exports: [APP_CONFIG, AppLogger, ReadinessProbe, TaskRegistry, DOMAIN_EVENT_HANDLERS],
})
export class AppModule {}
