import { Module } from '@nestjs/common';

import { LlmCapabilityService } from './application/llm-capability.service';
import { CacheModule } from '../shared/cache/cache.module';
import { APP_CONFIG } from '../shared/config/app-config.token';
import { CpuModule } from '../shared/cpu/cpu.module';
import { FinancialModule } from '../shared/financial/financial.module';
import { FINANCIAL_QUERY_TOOL } from './application/ports/financial-query.tool.port';
import { LLM_GATEWAY } from './application/ports/llm-gateway.port';
import { CATALOG_SOURCE } from './application/ports/semantic-catalog.port';
import { SQL_POLICY } from './application/ports/sql-policy.port';
import { SemanticCatalogService } from './application/semantic-catalog.service';
import { CachedFinancialQuery } from './infrastructure/cached-financial-query';
import { PgFinancialQueryTool } from './infrastructure/financial-query.tool';
import {
  OPENAI_COMPLETIONS,
  OpenAiLlmGateway,
  createOpenAiCompletions,
} from './infrastructure/openai-llm.gateway';
import { PgAstSqlPolicy } from './infrastructure/pg-ast-sql-policy';
import { SemanticCatalogBuilder } from './infrastructure/semantic-catalog.builder';

/**
 * What exists of the generation context so far: the tool the model is given, the
 * policy deciding what it may run, what this dataset holds, and the connection
 * to the model itself. The runner that puts them in a loop and the stream that
 * carries its output arrive in the phases after this one.
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
    SemanticCatalogBuilder,
    { provide: CATALOG_SOURCE, useExisting: SemanticCatalogBuilder },
    SemanticCatalogService,
    { provide: OPENAI_COMPLETIONS, useFactory: createOpenAiCompletions, inject: [APP_CONFIG] },
    OpenAiLlmGateway,
    { provide: LLM_GATEWAY, useExisting: OpenAiLlmGateway },
    LlmCapabilityService,
  ],
  exports: [FINANCIAL_QUERY_TOOL, SQL_POLICY, LLM_GATEWAY, SemanticCatalogService],
})
export class GenerationModule {}
