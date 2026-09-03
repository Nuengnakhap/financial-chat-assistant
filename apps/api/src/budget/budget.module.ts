import type { AppConfig } from '@fca/config';
import { Module } from '@nestjs/common';

import { ReservationEstimator } from './application/cost-estimator';
import { BUDGET_STORE } from './application/ports/budget.store';
import { USAGE_LEDGER } from './application/ports/usage-ledger.port';
import { PRICING, Pricing } from './application/pricing';
import { ReserveBudgetUseCase } from './application/use-cases/reserve-budget.use-case';
import { SettleUsageUseCase } from './application/use-cases/settle-usage.use-case';
import { DrizzleUsageLedger } from './infrastructure/drizzle-usage-ledger';
import { loadPricing } from './infrastructure/pricing.loader';
import { RedisLuaBudgetStore } from './infrastructure/redis-lua-budget.store';
import { UsageController } from './presentation/usage.controller';
import { IdentityModule } from '../identity/identity.module';
import { APP_CONFIG } from '../shared/config/app-config.token';
import { CpuModule } from '../shared/cpu/cpu.module';
import { SessionGuard } from '../shared/http/session.guard';
import { PersistenceModule } from '../shared/persistence/persistence.module';
import { RedisModule } from '../shared/redis/redis.module';

/**
 * What a generation is allowed to cost, and what it did cost.
 *
 * Nothing here knows what a generation is. The two contexts that do declare
 * their own narrow view of a budget and the composition root binds them to what
 * is exported below — so this can be replaced by an adapter that charges a
 * payment provider without either of them being opened.
 *
 * `IdentityModule` is imported for one thing, as it is in every context with a
 * controller: `SessionGuard` is built in the injector of the module whose
 * controllers use it.
 */
@Module({
  imports: [RedisModule, PersistenceModule, CpuModule, IdentityModule],
  controllers: [UsageController],
  providers: [
    { provide: BUDGET_STORE, useClass: RedisLuaBudgetStore },
    { provide: USAGE_LEDGER, useClass: DrizzleUsageLedger },
    {
      provide: PRICING,
      useFactory: (config: AppConfig): Pricing => loadPricing(config),
      inject: [APP_CONFIG],
    },
    ReservationEstimator,
    ReserveBudgetUseCase,
    SettleUsageUseCase,
    SessionGuard,
  ],
  exports: [ReserveBudgetUseCase, SettleUsageUseCase],
})
export class BudgetModule {}
