import type { UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';

import config from '../../../apps/web/vite.config';

/**
 * Both of the web app's servers reach the API the same way.
 *
 * `vite preview` serves the built page and does **not** inherit `server`, so a
 * `proxy` written under `server` alone leaves the prod-like run asking itself
 * for `/api` and getting its own `index.html` back — a 404 that reads as the API
 * being down. That run is the only check on the artefact rather than on the dev
 * server, so the two have to stay in step, and the way they stay in step is that
 * there is one object.
 *
 * Here rather than beside the web app's own tests, for a reason worth writing
 * down: those run under jsdom, where `new URL('./src', import.meta.url)` in the
 * config resolves to an `http:` URL that `fileURLToPath` refuses
 * (`ERR_INVALID_URL_SCHEME`). Build configuration is build tooling, and this
 * project runs on Node.
 */

interface Servers {
  readonly dev: UserConfig['server'];
  readonly built: UserConfig['preview'];
}

function resolved(): UserConfig {
  if (typeof config !== 'function') throw new Error('the vite config is no longer a function');
  const value = config({ command: 'serve', mode: 'test' });
  if (value instanceof Promise) throw new Error('the vite config is no longer synchronous');

  return value;
}

function servers(): Servers {
  const { server, preview } = resolved();

  return { dev: server, built: preview };
}

/** A proxy entry is a target string or an options object; only the target matters here. */
function targetOf(entry: string | { target?: unknown } | undefined): unknown {
  return typeof entry === 'string' ? entry : entry?.target;
}

describe('the dev server and the preview server', () => {
  it('proxy the same paths to the same place', () => {
    const { dev, built } = servers();

    expect(Object.keys(dev?.proxy ?? {})).toEqual(['/api', '/healthz']);
    // The same object, not an equal one: two literals are two things to keep
    // in step, which is what went wrong in the first place.
    expect(built?.proxy).toBe(dev?.proxy);
  });

  it('send those paths to the API port, wherever the environment puts it', () => {
    const { dev } = servers();
    const target = targetOf(dev?.proxy?.['/api']);

    // Read from the root `.env` rather than hardcoded: a changed `API_PORT`
    // otherwise looks like an outage rather than like a changed port.
    expect(target).toMatch(/^http:\/\/localhost:\d+$/u);
    expect(targetOf(dev?.proxy?.['/healthz'])).toBe(target);
  });

  it('listen on different ports, so one cannot be mistaken for the other', () => {
    const { dev, built } = servers();

    expect(dev?.port).toBe(5173);
    expect(built?.port).toBe(4173);
    // Strict, because a port chosen silently is a page nobody is looking at.
    expect(dev?.strictPort).toBe(true);
    expect(built?.strictPort).toBe(true);
  });
});

/**
 * The other half of the same promise, and it failed the same way: something the
 * built page needs, refused by the built page's own policy.
 */
describe('what the build inlines', () => {
  it("never inlines a font, because the policy says `font-src 'self'`", () => {
    const inline = resolved().build?.assetsInlineLimit;

    expect(inline).toBeTypeOf('function');
    if (typeof inline !== 'function') throw new Error('the inline limit is no longer a function');
    // A `data:` URL is not self, so a 2 kB subset that Vite would happily inline
    // becomes a blocked request and a console error on every load — of the built
    // page only, since the dev server serves fonts as files.
    expect(inline('assets/inter-latin-wght-normal.woff2', Buffer.of())).toBe(false);
    expect(inline('assets/mono.ttf', Buffer.of())).toBe(false);
    // Everything else keeps Vite's own judgement: `undefined` is "you decide".
    expect(inline('assets/favicon.svg', Buffer.of())).toBe(undefined);
  });
});
