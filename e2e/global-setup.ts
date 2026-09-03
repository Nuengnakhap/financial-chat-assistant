import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { request, type FullConfig } from '@playwright/test';

/**
 * Two accounts for the whole run, made once through the API.
 *
 * Registering per test is the obvious thing and it is wrong here for a reason
 * the product is right about: registration is throttled per host, ten in five
 * minutes, because saying whether an address is taken is something worth
 * rationing. A suite that registers nine times trips its own product's limit
 * and reports it as eight broken features — which is exactly what the first run
 * of this suite did.
 *
 * Two rather than one because isolation needs a stranger, and a stranger has to
 * be somebody.
 */

/**
 * From the working directory rather than from this module: Playwright loads
 * setup files as CommonJS, where `import.meta` does not exist — and the error
 * it produces names the module system rather than the line, which is a slow way
 * to find out.
 */
const HERE = join(process.cwd(), 'e2e');

export const MAIN_STATE = join(HERE, '.auth/main.json');
export const STRANGER_STATE = join(HERE, '.auth/stranger.json');

async function registerInto(baseURL: string, path: string, name: string): Promise<void> {
  const context = await request.newContext({ baseURL });
  const response = await context.post('/api/v1/auth/register', {
    data: {
      email: `e2e-${name}-${String(Date.now())}-${String(process.pid)}@example.test`,
      password: 'correct-horse-battery',
      displayName: name,
    },
  });

  if (!response.ok()) {
    throw new Error(
      `register answered ${String(response.status())}. Is \`pnpm dev\` running, and has the ` +
        'registration throttle had five minutes to forget the last run?',
    );
  }

  await context.storageState({ path });
  await context.dispose();
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:5173';
  mkdirSync(join(HERE, '.auth'), { recursive: true });

  await registerInto(baseURL, MAIN_STATE, 'Ada');
  await registerInto(baseURL, STRANGER_STATE, 'Grace');
}
