import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * The API is proxied rather than reached across origins. Both session cookies are
 * `SameSite=Strict` and the refresh cookie is pinned to `/api/v1/auth`; serving
 * the page and the API from one origin is what keeps those attributes meaningful,
 * and it matches how the two sit behind a single origin outside development.
 * Opening CORS instead would punch a hole in exactly what those attributes close.
 */
export default defineConfig(({ mode }) => {
  // The API reads API_PORT from the repository root .env, so the proxy reads the
  // same file. Hardcoding 3000 here makes a changed port look like an outage: the
  // page says the API is unreachable while the API is running perfectly well.
  const env = loadEnv(mode, '../..', '');
  const target = `http://localhost:${env['API_PORT'] ?? '3000'}`;
  // One definition, used by both servers. `vite preview` does not inherit
  // `server`, and a built page served without this asks itself for `/api` and
  // gets its own index.html back with a 404 — which reads as the API being
  // down. That is the only way to check the artefact rather than the dev
  // server, so it has to work.
  const proxy = { '/api': { target }, '/healthz': { target } };

  return {
    plugins: [react(), tailwindcss()],
    // `@fca/contracts` is built as CommonJS, because the API that also imports
    // it is. A browser asking a CommonJS file for a named export gets nothing,
    // and pre-bundling it instead traded that for a worse fault: Vite keys its
    // cache on the lockfile, not on a workspace package's output, so adding an
    // export to the contracts left the cached copy without it and the import
    // silently became `undefined` — a blank screen, no request, no error.
    //
    // Resolving to the source removes both. Vite compiles the TypeScript, an
    // edit to a contract hot-reloads the page, and there is no cache to go
    // stale. Types still come from the built `.d.ts`, and `pnpm build` keeps
    // that in step.
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@fca/contracts': fileURLToPath(new URL('../../packages/contracts/src', import.meta.url)),
      },
    },
    build: {
      // A font is never inlined, because the page's own CSP says `font-src
      // 'self'` and a `data:` URL is not self. Vite inlines any asset under 4 kB
      // by default, which caught exactly one file — a 2 kB Cyrillic subset of
      // the monospace face — and turned it into a blocked request and a console
      // error on every load of the **built** page only. The dev server serves
      // fonts as files, so nothing about this is visible until `vite preview`.
      //
      // Widening the policy to `font-src 'self' data:` would have worked too.
      // This way keeps the policy the narrower of the two: a font that arrives
      // as a file can be listed, cached and looked at.
      assetsInlineLimit: (path: string) =>
        /\.(woff2?|ttf|otf|eot)$/u.test(path) ? false : undefined,
    },
    server: { port: 5173, strictPort: true, proxy },
    // The prod-like local run: `pnpm build` then this, beside the API started
    // from its own `dist/`. A different port, so it cannot be mistaken for the
    // dev server while looking at the same screen.
    preview: { port: 4173, strictPort: true, proxy },
  };
});
