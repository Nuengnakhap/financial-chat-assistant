import { Module } from '@nestjs/common';

import { CacheModule } from '../shared/cache/cache.module';
import { CpuModule } from '../shared/cpu/cpu.module';
import { FinancialModule } from '../shared/financial/financial.module';
import { FINANCIAL_QUERY_TOOL } from './application/ports/financial-query.tool.port';
import { SQL_POLICY } from './application/ports/sql-policy.port';
import { CachedFinancialQuery } from './infrastructure/cached-financial-query';
import { PgFinancialQueryTool } from './infrastructure/financial-query.tool';
import { PgAstSqlPolicy } from './infrastructure/pg-ast-sql-policy';

/**
 * What exists of the generation context so far: the tool the model will be given
 * and the policy that decides what it may run. The model itself, the runner and
 * the stream arrive in the phases after this one — and this half is deliberately
 * first, because it is the half that needs no model to be proved right.
 */
@Module({
  imports: [FinancialModule, CacheModule, CpuModule],
  providers: [
    // `useExisting` rather than `useClass`: the policy loads a WebAssembly
    // module in `onModuleInit`, and two bindings of the same class would be two
    // instances of it, each booting a parser the other cannot see it has.
    PgAstSqlPolicy,
    { provide: SQL_POLICY, useExisting: PgAstSqlPolicy },
    CachedFinancialQuery,
    PgFinancialQueryTool,
    { provide: FINANCIAL_QUERY_TOOL, useExisting: PgFinancialQueryTool },
  ],
  exports: [FINANCIAL_QUERY_TOOL, SQL_POLICY],
})
export class GenerationModule {}
