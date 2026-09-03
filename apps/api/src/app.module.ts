import { loadConfig, type AppConfig } from '@fca/config';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { TaskRegistry } from './bootstrap/task-registry';
import { MODEL_IN_USE, type ModelInUse } from './budget/application/ports/model-in-use.port';
import { ReserveBudgetUseCase } from './budget/application/use-cases/reserve-budget.use-case';
import { SettleUsageUseCase } from './budget/application/use-cases/settle-usage.use-case';
import { BudgetModule } from './budget/budget.module';
import {
  GENERATION_BUDGET,
  type GenerationBudget,
} from './conversation/application/ports/budget.port';
import { ConversationModule } from './conversation/conversation.module';
import { ConversationDeletionSubscriber } from './conversation/infrastructure/conversation-deletion.subscriber';
import { LlmCapabilityService } from './generation/application/llm-capability.service';
import { USAGE_SETTLEMENT, type UsageSettlement } from './generation/application/ports/budget.port';
import { GenerationModule } from './generation/generation.module';
import { GenerationSubscriber } from './generation/infrastructure/generation.subscriber';
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
    BudgetModule,
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
      useFactory: (
        deletion: ConversationDeletionSubscriber,
        generation: GenerationSubscriber,
      ): readonly DomainEventHandler[] => [deletion, generation],
      inject: [ConversationDeletionSubscriber, GenerationSubscriber],
    },
    // The two contexts that spend a budget each declare their own narrow view
    // of one, and neither knows the other or the context that implements it.
    // This is where the three meet, which is the only place that has to change
    // if a budget ever comes from somewhere else.
    { provide: GENERATION_BUDGET, useExisting: ReserveBudgetUseCase },
    { provide: USAGE_SETTLEMENT, useExisting: SettleUsageUseCase },
    // Which way this one points is the whole reason it exists: the budget has
    // to put a price on a question before it is asked, and only the thing that
    // talks to the endpoint knows what a router resolved `auto` to.
    { provide: MODEL_IN_USE, useExisting: LlmCapabilityService },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
  exports: [
    APP_CONFIG,
    AppLogger,
    ReadinessProbe,
    TaskRegistry,
    DOMAIN_EVENT_HANDLERS,
    GENERATION_BUDGET,
    USAGE_SETTLEMENT,
    MODEL_IN_USE,
  ],
})
export class AppModule {}

/**
 * A `useExisting` binding is two names and a hope. Nothing above checks that
 * the class on one side has the methods the port on the other side declares —
 * it is resolved by token at runtime, so a rename turns into `is not a
 * function` at the moment somebody asks a question.
 *
 * These make it a build failure instead, the same way `ApiErrorCode` is held to
 * cover every `DomainErrorCode`.
 */
type Assert<T extends true> = T;
type _ReserverIsTheBudgetAConversationAsksFor = Assert<
  ReserveBudgetUseCase extends GenerationBudget ? true : false
>;
type _SettlerIsTheBudgetAGenerationAsksFor = Assert<
  SettleUsageUseCase extends UsageSettlement ? true : false
>;
type _CapabilityCheckKnowsWhichModelAnswers = Assert<
  LlmCapabilityService extends ModelInUse ? true : false
>;
