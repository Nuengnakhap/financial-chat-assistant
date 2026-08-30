import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkApiHealth } from '../health';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(implementation: () => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(implementation));
}

describe('checkApiHealth', () => {
  it('reports ready when the probe answers 200', async () => {
    stubFetch(() => Promise.resolve(new Response('{}', { status: 200 })));

    await expect(checkApiHealth(new AbortController().signal)).resolves.toBe('ready');
  });

  it('reports unreachable when the probe answers a failure status', async () => {
    stubFetch(() => Promise.resolve(new Response('{}', { status: 503 })));

    await expect(checkApiHealth(new AbortController().signal)).resolves.toBe('unreachable');
  });

  it('reports unreachable when the request throws rather than answering', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));

    await expect(checkApiHealth(new AbortController().signal)).resolves.toBe('unreachable');
  });

  it('passes the caller signal through so an unmount can cancel the request', async () => {
    stubFetch(() => Promise.resolve(new Response('{}', { status: 200 })));
    const controller = new AbortController();

    await checkApiHealth(controller.signal);

    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
