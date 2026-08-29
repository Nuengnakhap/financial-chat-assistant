import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'drizzle-kit';

/**
 * Migrations connect as the schema owner, which is a different role from the one
 * the running application uses — so a bug in a request cannot alter a table.
 *
 * drizzle-kit reads only `process.env`, and Node does not load a `.env` on its
 * own, so this does what the `start` script does with `--env-file-if-exists`.
 */
// Resolved from the working directory rather than the module: drizzle-kit
// bundles this file before running it, so `import.meta.dirname` is not set.
for (const candidate of ['.env', resolve('..', '..', '.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

export default defineConfig({
  schema: './src/shared/persistence/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env['MIGRATION_DATABASE_URL'] ?? '' },
  strict: true,
  verbose: true,
});
