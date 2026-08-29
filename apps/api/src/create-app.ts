import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { createFastifyAdapter } from './bootstrap/fastify';
import { AppLogger } from './shared/observability/app-logger';
import { NestLoggerBridge } from './shared/observability/nest-logger.bridge';

/**
 * Builds the application without listening, so a test drives the real wiring —
 * the same adapter, filter and providers — through injected requests instead of
 * a socket.
 */
export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter(), {
    bufferLogs: true,
  });

  app.useLogger(new NestLoggerBridge(app.get(AppLogger)));
  app.enableShutdownHooks();
  return app;
}
