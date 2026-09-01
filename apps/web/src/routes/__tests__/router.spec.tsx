import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppScreens } from '../router';

import { json, renderApp, signedIn, signedOut, stubApi } from '@/__tests__/harness';
import { announceSessionExpired } from '@/lib/api/session-expiry';

afterEach(() => {
  vi.unstubAllGlobals();
});

const DEVICES_KEY = ['auth', 'sessions'];

const ROOM = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Apple revenue',
  createdAt: '2026-08-31T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z',
};

const emptyRail = () => json({ items: [], nextCursor: null });

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
    stubApi((url) => (url.includes('/conversations') ? emptyRail() : signedIn()));

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
    stubApi((url) => (url.includes('/conversations') ? emptyRail() : signedIn()));
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
    stubApi((url) => (url.includes('/conversations') ? emptyRail() : signedIn()));

    renderApp(<AppScreens />, '/nothing-here');

    expect(await screen.findByText('Ada')).toBeInTheDocument();
  });

  it('reaches the list of devices from the rail', async () => {
    stubApi((url) => {
      if (url.endsWith('/auth/sessions')) return json({ sessions: [] });
      return url.includes('/conversations') ? emptyRail() : signedIn();
    });

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

describe('conversations on screen', () => {
  it('starts one and opens it, rather than leaving it in the rail to find', async () => {
    let created = false;
    stubApi((url, init) => {
      if (url.endsWith('/conversations') && init?.method === 'POST') {
        created = true;
        return json({ conversation: ROOM }, 201);
      }
      if (url.includes('/messages')) return json({ items: [], nextCursor: null });
      if (url.includes('/conversations'))
        return json({ items: created ? [ROOM] : [], nextCursor: null });
      return signedIn();
    });

    renderApp(<AppScreens />);
    await userEvent.click(await screen.findByRole('button', { name: 'New chat' }));

    // The conversation is open: its own screen, not the one that describes what
    // this can answer.
    expect(await screen.findByText(/Nothing has been asked here yet/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Apple revenue' })).toBeInTheDocument();
  });

  it('opens a conversation from the rail and shows what is in it', async () => {
    stubApi((url) => {
      if (url.includes('/messages')) {
        return json({
          items: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              conversationId: ROOM.id,
              seq: 1,
              role: 'user',
              status: 'complete',
              parts: [{ kind: 'text', text: 'What was Apple revenue?' }],
              verification: null,
              usage: null,
              error: null,
              createdAt: '2026-08-31T10:00:00.000Z',
            },
          ],
          nextCursor: null,
        });
      }
      if (url.includes('/conversations')) return json({ items: [ROOM], nextCursor: null });
      return signedIn();
    });

    renderApp(<AppScreens />);
    await userEvent.click(await screen.findByRole('link', { name: 'Apple revenue' }));

    expect(await screen.findByText('What was Apple revenue?')).toBeInTheDocument();
  });

  it('leaves the conversation it was reading when that conversation is deleted', async () => {
    // Staying on a page whose every read now answers 404 would show an error
    // for something that was asked for and worked.
    let deleted = false;
    const { calls } = stubApi((url, init) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        // Answered a tick late on purpose. The row is removed the moment it is
        // confirmed, so an answer that arrives before the re-render hides the
        // fact that the component holding the callback is already gone — which
        // is what left a deleted conversation on screen in a real browser.
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(json({ ok: true }, 202));
          }, 10);
        });
      }
      if (url.includes('/messages')) return json({ items: [], nextCursor: null });
      if (url.includes('/conversations')) {
        return json({ items: deleted ? [] : [ROOM], nextCursor: null });
      }
      return signedIn();
    });

    renderApp(<AppScreens />, `/c/${ROOM.id}`);
    await userEvent.click(
      await screen.findByRole('button', { name: 'More actions for Apple revenue' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );

    expect(
      await screen.findByRole('heading', { name: /Ask about the revenue and income/ }),
    ).toBeInTheDocument();

    // And it does not go asking for the history of what it just deleted. The
    // rail is keyed `['conversations']` and a history `['conversations', id,
    // 'messages']`, so invalidating the rail by prefix re-reads the thread too —
    // which the server answers 404 because it is right to.
    const removed = calls.findIndex((call) => call.startsWith('DELETE'));
    expect(calls.slice(removed).filter((call) => call.includes('/messages'))).toEqual([]);
  });
});
