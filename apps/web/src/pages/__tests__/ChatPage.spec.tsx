import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPage } from '../ChatPage';

import { eventStream, json, refused, renderApp, signedIn, stubApi } from '@/__tests__/harness';

/**
 * The screen with nothing open on it. What it has to get right is the handover:
 * a question typed here has nowhere to live until a conversation exists, and it
 * must not be lost — or asked twice — on the way.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOM = { id: '11111111-1111-4111-8111-111111111111', title: 'New chat' };

function serve(over: (url: string, init?: RequestInit) => Response | null) {
  return stubApi((url, init) => {
    const answer = over(url, init);
    if (answer !== null) return answer;
    if (url.includes('/stream')) return eventStream([]);
    if (url.includes('/messages')) return json({ items: [], nextCursor: null });
    if (url.includes('/conversations')) return json({ items: [], nextCursor: null });

    return signedIn();
  });
}

const QUESTION = 'What was the revenue of Apple in 2024?';
const ANSWER = 'aaaaaaaa-0000-4000-8000-000000000000';

/** The room, plus whatever the route is still carrying into it. */
function room() {
  return (
    <Routes>
      <Route
        path="/c/:id"
        element={
          <>
            <ChatPage />
            <Carrying />
          </>
        }
      />
    </Routes>
  );
}

function Carrying() {
  const { state } = useLocation();

  return state === null || state === undefined ? null : <p>a question in the history</p>;
}

describe('a room opened with a question', () => {
  it('asks it, and takes it out of the history so a reload does not ask again', async () => {
    const { calls } = serve((url, init) =>
      init?.method === 'POST' && url.includes('/messages')
        ? json(
            {
              assistantMessageId: ANSWER,
              streamPath: `/api/v1/messages/${ANSWER}/stream`,
              resumed: false,
            },
            202,
          )
        : null,
    );

    renderApp(room(), { pathname: `/c/${ROOM.id}`, state: { question: QUESTION } });

    await waitFor(() => {
      expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
    });
    // `navigate` with state writes to `history.state`, and `history.state`
    // survives a reload: left there, refreshing mid-answer asks the same
    // question a second time. Measured in a real browser, which is the only
    // place a reload exists — so what is pinned here is the state being gone.
    await waitFor(() => {
      expect(screen.queryByText('a question in the history')).not.toBeInTheDocument();
    });
  });

  it('asks nothing when the route carries nothing', async () => {
    const { calls } = serve(() => null);

    // Through a route, because the id comes from the path: rendered on its own
    // the page is the screen with nothing open on it.
    renderApp(room(), `/c/${ROOM.id}`);

    await waitFor(() => {
      expect(calls.some((call) => call.includes('/messages?limit'))).toBe(true);
    });
    // Nothing was asked: this route carries no question.
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([]);
  });
});

describe('the screen before anything is open', () => {
  it('offers questions this dataset can actually answer', async () => {
    serve(() => null);

    renderApp(<ChatPage />);

    // Each one names a company and a year the seed data holds, so somebody who
    // takes the invitation gets an answer rather than a polite refusal.
    expect(
      await screen.findByRole('button', { name: /revenue of Apple in 2024/ }),
    ).toBeInTheDocument();
  });

  it('makes a conversation and asks the question in it', async () => {
    const { calls } = serve((url, init) =>
      init?.method === 'POST' && url.endsWith('/conversations')
        ? json({ conversation: ROOM }, 201)
        : null,
    );

    renderApp(<ChatPage />);
    await userEvent.click(await screen.findByRole('button', { name: /revenue of Apple in 2024/ }));

    await waitFor(() => {
      expect(calls).toContain('POST /api/v1/conversations');
    });
  });

  it('stays where it is when the conversation could not be made', async () => {
    serve((url, init) =>
      init?.method === 'POST' && url.endsWith('/conversations')
        ? refused({ code: 'internal', message: 'No.', status: 500 })
        : null,
    );

    renderApp(<ChatPage />);
    const example = await screen.findByRole('button', { name: /revenue of Apple in 2024/ });
    await userEvent.click(example);

    // The examples are usable again: a failure here is not a state to be stuck
    // in, and the question is still on the screen to be picked.
    await waitFor(() => {
      expect(example).toBeEnabled();
    });
  });
});
