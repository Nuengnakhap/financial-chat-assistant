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

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target },
        '/healthz': { target },
      },
    },
  };
});
