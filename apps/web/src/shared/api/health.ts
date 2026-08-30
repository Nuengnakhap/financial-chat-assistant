export type ApiHealth = 'checking' | 'ready' | 'unreachable';

/**
 * The one request this milestone makes, and the proof that the dev proxy is
 * wired: the page is served from :5173 and this resolves on :3000 without the
 * browser ever seeing a second origin. A typed client over `@fca/contracts`
 * replaces every other call at M5.3; readiness is not a contract, so it stays
 * a path.
 */
export async function checkApiHealth(signal: AbortSignal): Promise<ApiHealth> {
  try {
    const response = await fetch('/healthz/ready', { signal });
    return response.ok ? 'ready' : 'unreachable';
  } catch {
    // A network failure and a refused connection are the same thing to a reader.
    return 'unreachable';
  }
}
