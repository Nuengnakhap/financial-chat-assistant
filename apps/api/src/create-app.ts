import fastifyCookie from '@fastify/cookie';
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

  // Cookies are how every credential travels, so the parser is part of building
  // the app rather than something a controller remembers to ask for.
  await app.register(fastifyCookie);
  app.useLogger(new NestLoggerBridge(app.get(AppLogger)));
  // No `enableShutdownHooks()`: it installs its own signal handlers that call
  // `close()` straight away, racing the ordered sequence in `main.ts`.
  return app;
}
