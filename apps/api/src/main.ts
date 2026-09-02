import 'reflect-metadata';

import { Server } from 'node:http';

import type { AppConfig } from '@fca/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { DEFAULT_SHUTDOWN_TIMINGS, runShutdown, type ShutdownTarget } from './bootstrap/shutdown';
import { TaskRegistry } from './bootstrap/task-registry';
import { createApp } from './create-app';
import { APP_CONFIG } from './shared/config/app-config.token';
import { ReadinessProbe } from './shared/health/readiness';
import { SseStream } from './shared/http/sse-stream';
import { AppLogger, asError } from './shared/observability/app-logger';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get(AppLogger);

  // 0.0.0.0 so the port is reachable from outside a container.
  await app.listen({ port: config.app.port, host: '0.0.0.0' });
  logger.log(`api listening on ${String(config.app.port)}`);

  let stopping = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      // A second signal during the sequence is impatience, not new information.
      if (stopping) return;
      stopping = true;

      void runShutdown({
        target: shutdownTargetFor(app),
        readiness: app.get(ReadinessProbe),
        streams: app.get(SseStream),
        tasks: app.get(TaskRegistry),
        logger,
        timings: DEFAULT_SHUTDOWN_TIMINGS,
      }).catch((error: unknown) => {
        logger.error('shutdown failed', { err: asError(error) });
        process.exitCode = 1;
      });
    });
  }
}

function shutdownTargetFor(app: NestFastifyApplication): ShutdownTarget {
  // Typed by narrowing rather than by the adapter, whose accessor returns `any`.
  const httpServer: unknown = app.getHttpServer();

  return {
    stopAcceptingRequests: async () => {
      await app.getHttpAdapter().close();
    },
    cutConnections: () => {
      if (httpServer instanceof Server) httpServer.closeAllConnections();
    },
    release: () => app.close(),
  };
}

bootstrap().catch((error: unknown) => {
  // Nothing is wired up yet, so this cannot go through AppLogger.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
});
