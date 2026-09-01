import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { messagesInOrder } from '../api/messages';
import { MessageThread } from '../components/MessageThread';

import { json, refused, renderApp, stubApi } from '@/__tests__/harness';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ID = '11111111-1111-4111-8111-111111111111';

const message = (seq: number, text: string) => ({
  id: `0000000${String(seq)}-0000-4000-8000-000000000000`,
  conversationId: ID,
  seq,
  role: 'user' as const,
  status: 'complete' as const,
  parts: [{ kind: 'text' as const, text }],
  verification: null,
  usage: null,
  error: null,
  createdAt: '2026-08-31T10:00:00.000Z',
});

const page = (items: readonly unknown[], nextCursor: string | null = null) =>
  json({ items, nextCursor });

describe('reading a conversation', () => {
  it('shows what was said, in the order it was said', async () => {
    stubApi(() => page([message(1, 'first thing'), message(2, 'second thing')]));

    renderApp(<MessageThread conversationId={ID} />);

    const said = await screen.findAllByText(/thing$/);
    expect(said.map((node) => node.textContent)).toEqual(['first thing', 'second thing']);
  });

  it('says nothing has been asked rather than showing an empty page', async () => {
    stubApi(() => page([]));

    renderApp(<MessageThread conversationId={ID} />);

    expect(await screen.findByText(/Nothing has been asked here yet/)).toBeInTheDocument();
  });

  it('offers to read again when it could not be read', async () => {
    let attempts = 0;
    stubApi(() => {
      attempts += 1;
      return attempts === 1
        ? refused({ code: 'internal', message: 'Something went wrong on our side.', status: 500 })
        : page([message(1, 'first thing')]);
    });

    renderApp(<MessageThread conversationId={ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('first thing')).toBeInTheDocument();
  });

  it('shows nothing to retry for a conversation that is not there', async () => {
    // Deleted from another tab, or by the rail while this was open. There is
    // nothing to try again — the page is on its way back to the start.
    stubApi(() => refused({ code: 'not_found', message: 'That does not exist.', status: 404 }));

    renderApp(<MessageThread conversationId={ID} />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('asks for the newest page first, without a cursor', async () => {
    const { calls } = stubApi(() => page([message(1, 'first thing')]));

    renderApp(<MessageThread conversationId={ID} />);
    await screen.findByText('first thing');

    expect(calls[0]).toContain(`/conversations/${ID}/messages?limit=100`);
    expect(calls[0]).not.toContain('cursor');
  });
});

describe('putting the pages back in order', () => {
  it('reads downwards even though the newest page arrived first', () => {
    // The server hands back the end of the conversation first and each page
    // after it is older, so the pages are reversed and their contents are not.
    const newest = { items: [message(3, 'third'), message(4, 'fourth')], nextCursor: 'older' };
    const older = { items: [message(1, 'first'), message(2, 'second')], nextCursor: null };

    const inOrder = messagesInOrder([newest, older]);

    expect(inOrder.map((one) => one.seq)).toEqual([1, 2, 3, 4]);
  });
});
