import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppScreens } from '../router';

import { json, renderApp, signedIn, signedOut, stubApi } from '@/__tests__/harness';
import { announceSessionExpired } from '@/lib/api/session-expiry';

afterEach(() => {
  vi.unstubAllGlobals();
});

const DEVICES_KEY = ['auth', 'sessions'];

const DEVICE = {
  id: '11111111-1111-4111-8111-111111111111',
  device: 'Chrome on macOS',
  ipHash: 'abcdef0123456789',
  lastUsedAt: new Date().toISOString(),
  current: true,
};

/**
 * The screens with a memory history under them. What is driven here is the API,
 * not the router: the same thing a person changes.
 */
describe('the application', () => {
  it('opens on the chat screen for someone signed in', async () => {
    stubApi(() => signedIn());

    renderApp(<AppScreens />);

    expect(await screen.findByText('Ada')).toBeInTheDocument();
  });

  it('opens on the sign-in screen for someone who is not', async () => {
    stubApi(() => signedOut());

    renderApp(<AppScreens />);

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('sends the person to sign in when the session ends under them', async () => {
    // A refresh refused somewhere else in the application. Wherever they were
    // standing, the session is over and the screen has to say so.
    stubApi(() => signedIn());
    renderApp(<AppScreens />);
    expect(await screen.findByText('Ada')).toBeInTheDocument();

    act(() => {
      announceSessionExpired();
    });

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('empties the cache of the previous person when the session expires', async () => {
    // Three things end a session — signing out, revoking the one you hold, and a
    // refused refresh — and all three have to leave the same nothing behind.
    // This one did not, so the device list of whoever was here stayed in the
    // cache, and the next person to sign in on this machine would have been
    // handed it as a fresh answer. Asserted against the cache rather than the
    // screen: the screen is empty either way, because the redirect unmounts it.
    stubApi(() => signedIn());
    const { queryClient } = renderApp(<AppScreens />);
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    queryClient.setQueryData(DEVICES_KEY, [DEVICE]);

    act(() => {
      announceSessionExpired();
    });

    expect(queryClient.getQueryData(DEVICES_KEY)).toBeUndefined();
  });

  it('sends an address nobody recognises back to the application', async () => {
    stubApi(() => signedIn());

    renderApp(<AppScreens />, '/nothing-here');

    expect(await screen.findByText('Ada')).toBeInTheDocument();
  });

  it('reaches the list of devices from the rail', async () => {
    stubApi((url) => (url.endsWith('/auth/sessions') ? json({ sessions: [] }) : signedIn()));

    renderApp(<AppScreens />);
    await userEvent.click(await screen.findByRole('link', { name: 'Signed-in devices' }));

    expect(await screen.findByRole('heading', { name: 'Signed-in devices' })).toBeInTheDocument();
  });

  it('leaves the application when the revoked device is the one being used', async () => {
    // The server clears the cookies in the same answer, so staying on a screen
    // that needs them until the next request fails is showing something that is
    // already untrue.
    const here = {
      id: '11111111-1111-4111-8111-111111111111',
      device: 'Chrome on macOS',
      ipHash: 'abcdef0123456789',
      lastUsedAt: new Date().toISOString(),
      current: true,
    };
    let signedInStill = true;
    stubApi((url, init) => {
      if (init?.method === 'DELETE') {
        signedInStill = false;
        return json({ ok: true });
      }
      if (url.endsWith('/auth/sessions')) return json({ sessions: [here] });
      if (init?.method === 'POST') return signedOut();
      return signedInStill ? signedIn() : signedOut();
    });

    renderApp(<AppScreens />, '/sessions');
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('signs out and returns to the sign-in screen', async () => {
    let signedInStill = true;
    stubApi((url, init) => {
      if (url.endsWith('/auth/logout')) {
        signedInStill = false;
        return json({ ok: true });
      }
      if (init?.method === 'POST') return signedOut();
      return signedInStill ? signedIn() : signedOut();
    });

    renderApp(<AppScreens />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
