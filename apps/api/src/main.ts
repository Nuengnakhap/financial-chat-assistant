import 'reflect-metadata';

import type { AppConfig } from '@fca/config';

import { APP_CONFIG } from './app.module';
import { createApp } from './create-app';
import { AppLogger } from './shared/observability/app-logger';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get<AppConfig>(APP_CONFIG);

  // 0.0.0.0 so the port is reachable from outside a container.
  await app.listen({ port: config.app.port, host: '0.0.0.0' });
  app.get(AppLogger).log(`api listening on ${String(config.app.port)}`);
}

bootstrap().catch((error: unknown) => {
  // Nothing is wired up yet, so this cannot go through AppLogger.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
});
