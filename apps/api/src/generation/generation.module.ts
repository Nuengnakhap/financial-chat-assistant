import { Module } from '@nestjs/common';

import { AgentRunner } from './application/agent-runner';
import { AnswerBooks } from './application/answer-books';
import { GenerationContextFactory } from './application/generation-context';
import { GenerationJanitor } from './application/generation-janitor';
import { GenerationSupervisor } from './application/generation-supervisor';
import { LlmCapabilityService } from './application/llm-capability.service';
import { AGENT_TOOLS, type AgentTool } from './application/ports/agent-tool.port';
import { GENERATION_EVENTS } from './application/ports/generation-events.port';
import { GENERATION_MESSAGES } from './application/ports/generation-messages.port';
import { GENERATION_STOPS } from './application/ports/generation-stops.port';
import { LLM_GATEWAY } from './application/ports/llm-gateway.port';
import { CATALOG_SOURCE } from './application/ports/semantic-catalog.port';
import { SQL_POLICY } from './application/ports/sql-policy.port';
import { RunGenerationUseCase } from './application/run-generation.use-case';
import { SemanticCatalogService } from './application/semantic-catalog.service';
import { EndAbandonedGenerationsUseCase } from './application/use-cases/end-abandoned-generations.use-case';
import { StopGenerationUseCase } from './application/use-cases/stop-generation.use-case';
import { WatchGenerationUseCase } from './application/use-cases/watch-generation.use-case';
import { CachedFinancialQuery } from './infrastructure/cached-financial-query';
import { CountingGenerationEvents } from './infrastructure/counting-generation-events';
import { CountingSqlPolicy } from './infrastructure/counting-sql-policy';
import { DescribeCoverageTool } from './infrastructure/describe-coverage.tool';
import { DrizzleGenerationMessages } from './infrastructure/drizzle-generation-messages';
import { PgFinancialQueryTool } from './infrastructure/financial-query.tool';
import { GenerationStream } from './infrastructure/generation-stream';
import { GenerationSubscriber } from './infrastructure/generation.subscriber';
import {
  OPENAI_COMPLETIONS,
  OpenAiLlmGateway,
  createOpenAiCompletions,
} from './infrastructure/openai-llm.gateway';
import { PgAstSqlPolicy } from './infrastructure/pg-ast-sql-policy';
import { RedisGenerationStops } from './infrastructure/redis-generation-stops';
import { SemanticCatalogBuilder } from './infrastructure/semantic-catalog.builder';
import { GenerationController } from './presentation/generation.controller';
import { IdentityModule } from '../identity/identity.module';
import { CacheModule } from '../shared/cache/cache.module';
import { APP_CONFIG } from '../shared/config/app-config.token';
import { CpuModule } from '../shared/cpu/cpu.module';
import { FinancialModule } from '../shared/financial/financial.module';
import { SessionGuard } from '../shared/http/session.guard';
import { SseStream } from '../shared/http/sse-stream';
import { PersistenceModule } from '../shared/persistence/persistence.module';
import { RedisModule } from '../shared/redis/redis.module';
import { StreamMultiplexer } from '../shared/redis/stream-multiplexer';

/**
 * The whole of generation: what the model may run, what it is told, how it is
 * asked, and how what comes back reaches a person.
 *
 * `IdentityModule` is imported for one thing, as it is in the conversation
 * context: `SessionGuard` is built in the injector of the module whose
 * controllers use it, and the token issuer it verifies with is bound there.
 */
@Module({
  imports: [
    FinancialModule,
    CacheModule,
    CpuModule,
    RedisModule,
    PersistenceModule,
    IdentityModule,
  ],
  controllers: [GenerationController],
  providers: [
    // `useExisting` rather than `useClass`: the policy loads a WebAssembly
    // module in `onModuleInit`, and two bindings of the same class would be two
    // instances of it, each booting a parser the other cannot see it has.
    PgAstSqlPolicy,
    // Wrapped so the policy stays a pure function of a string, with nothing to
    // reset between calls, and the numbers still get counted per rule.
    CountingSqlPolicy,
    { provide: SQL_POLICY, useExisting: CountingSqlPolicy },
    CachedFinancialQuery,
    PgFinancialQueryTool,
    DescribeCoverageTool,
    // The registry. Adding a third tool is a class and a line here — the runner
    // sends whatever is in this array and dispatches by the name the model used,
    // and has no idea what any of them do. See CONTRIBUTING.md.
    {
      provide: AGENT_TOOLS,
      useFactory: (
        query: PgFinancialQueryTool,
        coverage: DescribeCoverageTool,
      ): readonly AgentTool[] => [query, coverage],
      inject: [PgFinancialQueryTool, DescribeCoverageTool],
    },
    SemanticCatalogBuilder,
    { provide: CATALOG_SOURCE, useExisting: SemanticCatalogBuilder },
    SemanticCatalogService,
    { provide: OPENAI_COMPLETIONS, useFactory: createOpenAiCompletions, inject: [APP_CONFIG] },
    OpenAiLlmGateway,
    { provide: LLM_GATEWAY, useExisting: OpenAiLlmGateway },
    LlmCapabilityService,
    GenerationContextFactory,
    AgentRunner,
    StreamMultiplexer,
    GenerationStream,
    // Wrapped rather than instrumented: the stream is the one place every
    // generation event passes, so the numbers cost no parameter anywhere else.
    CountingGenerationEvents,
    { provide: GENERATION_EVENTS, useExisting: CountingGenerationEvents },
    DrizzleGenerationMessages,
    { provide: GENERATION_MESSAGES, useExisting: DrizzleGenerationMessages },
    RedisGenerationStops,
    { provide: GENERATION_STOPS, useExisting: RedisGenerationStops },
    AnswerBooks,
    RunGenerationUseCase,
    GenerationSupervisor,
    GenerationSubscriber,
    EndAbandonedGenerationsUseCase,
    GenerationJanitor,
    WatchGenerationUseCase,
    StopGenerationUseCase,
    SseStream,
    SessionGuard,
  ],
  // `SseStream` leaves so that shutdown can tell every open reader to come back
  // before the server stops accepting connections; the subscriber leaves for the
  // handler list the composition root builds.
  exports: [
    AGENT_TOOLS,
    SQL_POLICY,
    LLM_GATEWAY,
    GenerationSubscriber,
    SseStream,
    // Leaves this module for one reason: what a router resolved `auto` to is
    // what the budget has to put a price on before a question is asked, and
    // this is the only thing that has spoken to the endpoint.
    LlmCapabilityService,
  ],
})
export class GenerationModule {}
