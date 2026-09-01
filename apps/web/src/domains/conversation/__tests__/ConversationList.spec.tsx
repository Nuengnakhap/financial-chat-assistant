import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationList } from '../components/ConversationList';

import { json, refused, renderApp, stubApi } from '@/__tests__/harness';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOM = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Apple revenue',
  createdAt: '2026-08-31T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z',
};
const OTHER = { ...ROOM, id: '22222222-2222-4222-8222-222222222222', title: 'Microsoft income' };

const page = (items: readonly unknown[], nextCursor: string | null = null) =>
  json({ items, nextCursor });

/** Open the row's menu, choose Delete, and answer the question it asks. */
async function deleteApple(): Promise<void> {
  await userEvent.click(
    await screen.findByRole('button', { name: 'More actions for Apple revenue' }),
  );
  await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
}

describe('the rail', () => {
  it('lists what there is, and links each one to its own address', async () => {
    stubApi(() => page([ROOM, OTHER]));

    renderApp(<ConversationList />);

    expect(await screen.findByRole('link', { name: 'Apple revenue' })).toHaveAttribute(
      'href',
      `/c/${ROOM.id}`,
    );
    expect(screen.getByRole('link', { name: 'Microsoft income' })).toBeInTheDocument();
  });

  it('highlights the whole row it is on, not the title inside it', async () => {
    // On the link the highlight stopped where the link stopped, leaving the
    // menu button sitting in a notch of bare rail.
    stubApi(() => page([ROOM, OTHER]));

    renderApp(<ConversationList />, `/c/${ROOM.id}`);

    const row = (await screen.findByRole('link', { name: 'Apple revenue' })).closest('li');
    expect(row).toHaveClass('bg-raised');
    expect(screen.getByRole('link', { name: 'Apple revenue' })).not.toHaveClass('bg-raised');
    expect(screen.getByRole('link', { name: 'Microsoft income' }).closest('li')).not.toHaveClass(
      'bg-raised',
    );
  });

  it('says so when there is nothing rather than showing an empty box', async () => {
    stubApi(() => page([]));

    renderApp(<ConversationList />);

    expect(await screen.findByText('No conversations yet.')).toBeInTheDocument();
  });

  it('offers to read again when the list could not be read at all', async () => {
    let attempts = 0;
    stubApi(() => {
      attempts += 1;
      return attempts === 1
        ? refused({ code: 'internal', message: 'Something went wrong on our side.', status: 500 })
        : page([ROOM]);
    });

    renderApp(<ConversationList />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('link', { name: 'Apple revenue' })).toBeInTheDocument();
  });

  it('asks for the page it was told about rather than the first one again', async () => {
    // The cursor is opaque, so the only thing worth asserting is that whatever
    // the server said came back to it untouched.
    const { calls } = stubApi((url) =>
      url.includes('cursor=') ? page([OTHER]) : page([ROOM], 'older-than-this'),
    );

    renderApp(<ConversationList />);
    await screen.findByRole('link', { name: 'Apple revenue' });
    // jsdom has no IntersectionObserver, so the sentinel never fires here — the
    // browser is what proves the scroll. What is proven here is the request.
    await waitFor(() => {
      expect(calls.some((call) => call.includes('limit=50'))).toBe(true);
    });
    expect(calls.every((call) => !call.includes('cursor=undefined'))).toBe(true);
  });
});

describe('deleting a conversation', () => {
  it('offers the action in a menu rather than in every row', async () => {
    const { calls } = stubApi(() => page([ROOM]));

    renderApp(<ConversationList />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'More actions for Apple revenue' }),
    );

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('asks before it deletes, and naming what goes is the point of asking', async () => {
    const { calls } = stubApi(() => page([ROOM]));

    renderApp(<ConversationList />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'More actions for Apple revenue' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const asked = screen.getByRole('dialog');
    expect(asked).toHaveTextContent('Apple revenue');
    expect(asked).toHaveTextContent(/cannot be undone/);
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('closes the menu without deleting when Escape is pressed', async () => {
    const { calls } = stubApi(() => page([ROOM]));

    renderApp(<ConversationList />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'More actions for Apple revenue' }),
    );
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('takes the row away before the server has answered', async () => {
    // The server answers 202: the conversation is already gone from every read
    // by then, so leaving the row up until the answer arrives shows something
    // untrue for as long as that takes. Held open on purpose — waiting for the
    // answer first would pass whether the removal was optimistic or not.
    let answer = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    stubApi(async (_url, init) => {
      if (init?.method !== 'DELETE') return page([ROOM, OTHER]);
      await held;
      return json({ ok: true }, 202);
    });

    renderApp(<ConversationList />);
    await deleteApple();

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Apple revenue' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Microsoft income' })).toBeInTheDocument();
    answer();
  });

  it('leaves it gone once the list has been read again', async () => {
    let deleted = false;
    stubApi((_url, init) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        return json({ ok: true }, 202);
      }
      return page(deleted ? [OTHER] : [ROOM, OTHER]);
    });

    renderApp(<ConversationList />);
    await deleteApple();

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Apple revenue' })).not.toBeInTheDocument();
    });
    // Still gone after the rail re-read itself, which is the check that the
    // optimistic removal agreed with the server rather than hid a failure.
    expect(await screen.findByRole('link', { name: 'Microsoft income' })).toBeInTheDocument();
  });

  it('puts the row back when the deletion failed', async () => {
    // A row that vanished and a request that failed would leave the person
    // believing something was deleted.
    stubApi((url, init) =>
      init?.method === 'DELETE'
        ? refused({ code: 'internal', message: 'Something went wrong on our side.', status: 500 })
        : page([ROOM]),
    );

    renderApp(<ConversationList />);
    await deleteApple();

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    expect(await screen.findByRole('link', { name: 'Apple revenue' })).toBeInTheDocument();
  });

  it('leaves the conversation alone when the question is cancelled', async () => {
    const { calls } = stubApi(() => page([ROOM]));

    renderApp(<ConversationList />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'More actions for Apple revenue' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );

    expect(screen.getByRole('link', { name: 'Apple revenue' })).toBeInTheDocument();
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });
});
