import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { messagesInOrder } from '../api/messages';
import { ChatRoom } from '../components/ChatRoom';

import {
  eventStream,
  frame,
  freshCache,
  json,
  pushableStream,
  refused,
  renderApp,
  stubApi,
} from '@/__tests__/harness';

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

    renderApp(<ChatRoom conversationId={ID} />);

    const said = await screen.findAllByText(/thing$/);
    expect(said.map((node) => node.textContent)).toEqual(['first thing', 'second thing']);
  });

  it('invites the first question rather than showing an empty page', async () => {
    stubApi(() => page([]));

    renderApp(<ChatRoom conversationId={ID} />);

    expect(await screen.findByText(/Ask the first question/)).toBeInTheDocument();
  });

  it('offers to read again when it could not be read', async () => {
    // Which read fails is decided by a state the test controls rather than by
    // counting: a screen mounts, is torn down and mounts again on its way in,
    // so "the first request" is not a thing the test can name.
    let readable = false;
    stubApi(() =>
      readable
        ? page([message(1, 'first thing')])
        : refused({ code: 'internal', message: 'Something went wrong on our side.', status: 500 }),
    );

    renderApp(<ChatRoom conversationId={ID} />);
    const again = await screen.findByRole('button', { name: 'Try again' });
    readable = true;
    await userEvent.click(again);

    expect(await screen.findByText('first thing')).toBeInTheDocument();
  });

  it('shows nothing to retry for a conversation that is not there', async () => {
    // Deleted from another tab, or by the rail while this was open. There is
    // nothing to try again — the page is on its way back to the start.
    stubApi(() => refused({ code: 'not_found', message: 'That does not exist.', status: 404 }));

    renderApp(<ChatRoom conversationId={ID} />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('asks for the newest page first, without a cursor', async () => {
    const { calls } = stubApi(() => page([message(1, 'first thing')]));

    renderApp(<ChatRoom conversationId={ID} />);
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

const ANSWER = 'aaaaaaaa-0000-4000-8000-000000000000';

const REPORT = {
  verdict: 'pass' as const,
  checkedClaims: [
    {
      text: '$391.0B',
      value: '391035000000',
      toolCallId: 'call_1',
      rowIndex: 0,
      column: 'revenue',
    },
  ],
  violations: [],
};

/**
 * The four calls a conversation makes, answered by URL. Written as one function
 * so a test says what is different about it rather than restating the whole
 * conversation every time.
 */
interface Server {
  readonly history?: () => Response;
  readonly stream?: () => Response;
}

function serve({ history, stream }: Server) {
  return stubApi((url, init) => {
    if (url.includes('/stream')) return (stream ?? (() => eventStream([])))();
    if (url.includes('/stop')) return json({ ok: true }, 202);
    if (init?.method === 'POST')
      return json(
        {
          assistantMessageId: ANSWER,
          streamPath: `/api/v1/messages/${ANSWER}/stream`,
          resumed: false,
        },
        202,
      );

    return (history ?? (() => page([])))();
  });
}

const answered = (parts: readonly unknown[], status = 'complete') => ({
  id: ANSWER,
  conversationId: ID,
  seq: 2,
  role: 'assistant' as const,
  status,
  parts,
  verification: status === 'complete' ? REPORT : null,
  usage: null,
  error: null,
  createdAt: '2026-08-31T10:00:00.000Z',
});

async function ask(question = 'What was the revenue of Apple in 2024?'): Promise<void> {
  renderApp(<ChatRoom conversationId={ID} />);
  await screen.findByText(/Ask the first question/);
  await userEvent.type(screen.getByLabelText('Ask a question'), question);
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('asking a question', () => {
  it('shows the question before the server has answered anything', async () => {
    serve({ stream: () => eventStream([], true) });

    await ask('What was the revenue of Apple in 2024?');

    // The command is still in flight. Somebody who pressed send and saw nothing
    // would press it again.
    expect(await screen.findByText('What was the revenue of Apple in 2024?')).toBeInTheDocument();
    expect(await screen.findByText(/Working on it/)).toBeInTheDocument();
  });

  it('shows the query being written, then the rows it came back with', async () => {
    serve({
      stream: () =>
        eventStream(
          [
            frame('1-0', {
              type: 'generation_started',
              assistantMessageId: ANSWER,
              model: 'a-model',
            }),
            frame('2-0', {
              type: 'tool_call_delta',
              index: 0,
              argsDelta: '{"sql":"SELECT revenue',
            }),
            frame('3-0', {
              type: 'tool_call_ready',
              id: 'call_1',
              sql: 'SELECT revenue FROM financial_data',
            }),
            frame('4-0', {
              type: 'tool_result',
              toolCallId: 'call_1',
              rowCount: 1,
              preview: [{ company: 'Apple', revenue: '391035000000' }],
              elapsedMs: 4,
              error: null,
            }),
          ],
          true,
        ),
    });

    await ask();

    // The whole point of the screen: the statement that produced the figure is
    // readable beside it, as it happens.
    expect(await screen.findByText(/SELECT revenue FROM financial_data/)).toBeInTheDocument();
    expect(await screen.findByText('391035000000')).toBeInTheDocument();
    expect(await screen.findByText(/1 row/)).toBeInTheDocument();
  });

  it('says an answer was verified once it is one', async () => {
    // The answer becomes a row when the generation has run, not on the second
    // read: a screen mounting twice on its way in reads the history twice
    // before anything has been asked.
    let generated = false;
    serve({
      history: () =>
        generated ? page([answered([{ kind: 'text', text: 'Apple earned $391.0B.' }])]) : page([]),
      stream: () => {
        generated = true;
        return eventStream([
          frame('1-0', { type: 'text_delta', delta: 'Apple earned $391.0B.' }),
          frame('2-0', { type: 'verification', report: REPORT }),
          frame('3-0', {
            type: 'message_complete',
            message: answered([{ kind: 'text', text: 'Apple earned $391.0B.' }]),
          }),
        ]);
      },
    });

    await ask();

    // The badge is the one claim this interface makes on its own behalf, and it
    // comes from the stored message rather than from anything the page kept.
    expect(await screen.findByLabelText(/Verified: 1 figure checked/)).toBeInTheDocument();
  });
});

describe('an answer that was already being written', () => {
  it('is picked up when the page loads, without being asked for again', async () => {
    const { calls } = serve({
      history: () => page([answered([], 'generating')]),
      stream: () =>
        eventStream([frame('7-0', { type: 'text_delta', delta: 'Apple earned $391.0B.' })], true),
    });

    renderApp(<ChatRoom conversationId={ID} />);

    expect(await screen.findByText('Apple earned $391.0B.')).toBeInTheDocument();
    // Nothing was sent: the answer was already being written, and this page is
    // reading it rather than starting it.
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([]);
    expect(calls.some((call) => call.includes(`/messages/${ANSWER}/stream`))).toBe(true);
  });
});

describe('stopping', () => {
  it('asks the server rather than closing the connection', async () => {
    const { calls } = serve({
      stream: () => eventStream([frame('1-0', { type: 'text_delta', delta: 'Apple' })], true),
    });

    await ask();
    await screen.findByText('Apple');
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    // Disconnecting would leave the answer being written and the row unfinished.
    // Stopping is a command about the generation, not about this socket.
    expect(calls).toContain(`POST /api/v1/messages/${ANSWER}/stop`);
  });
});

describe('a draft the gate stopped', () => {
  it('clears the text and keeps the query it was written from', async () => {
    serve({
      stream: () =>
        eventStream(
          [
            frame('1-0', {
              type: 'tool_call_ready',
              id: 'call_1',
              sql: 'SELECT revenue FROM financial_data',
            }),
            frame('2-0', { type: 'text_delta', delta: 'Apple earned $400B.' }),
            frame('3-0', { type: 'draft_reset', attempt: 2, reason: 'unverifiable_claim' }),
          ],
          true,
        ),
    });

    await ask();
    await screen.findByText(/Re-checking figures/);

    // The figure with nothing behind it is gone; the query it was written from
    // stays, because the data did not change — only what was said about it.
    expect(screen.queryByText(/\$400B/)).not.toBeInTheDocument();
    expect(screen.getByText(/SELECT revenue FROM financial_data/)).toBeInTheDocument();
  });
});

describe('a message with a part this build cannot read', () => {
  it('is refused where it arrives rather than drawn as half a message', async () => {
    serve({
      history: () => page([answered([{ kind: 'text', text: 'fine' }, { kind: 'nonsense' }])]),
    });

    renderApp(<ChatRoom conversationId={ID} />);

    // The contract parses every response, so a part nothing can render never
    // reaches a component. Half an answer on screen would be worse than a page
    // that says it could not be read and offers to try again.
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('a connection that drops mid-answer', () => {
  it('comes back from the last event it saw, keeping what is on screen', async () => {
    let attempts = 0;
    const { calls } = serve({
      stream: () => {
        attempts += 1;
        // The first response ends without a terminal event, the way a draining
        // pod or an impatient proxy ends one.
        return attempts === 1
          ? eventStream([frame('5-0', { type: 'text_delta', delta: 'Apple earned ' })])
          : eventStream([frame('6-0', { type: 'text_delta', delta: '$391.0B.' })], true);
      },
    });

    await ask();

    expect(await screen.findByText(/Apple earned \$391\.0B\./)).toBeInTheDocument();
    // Resumed by position, so the first half is not read twice and the second
    // half is not lost.
    expect(calls.filter((call) => call.includes('/stream'))).toHaveLength(2);
  });

  it('says it is reconnecting without clearing the answer', async () => {
    serve({
      stream: () => eventStream([frame('5-0', { type: 'text_delta', delta: 'Apple earned ' })]),
    });

    await ask();

    // The answer is still being written on the server throughout. A reconnect
    // that cleared the screen would look like a restart.
    expect(await screen.findByText(/Reconnecting/)).toBeInTheDocument();
    expect(screen.getByText(/Apple earned/)).toBeInTheDocument();
  });

  it('stops when the server refused rather than dropped, however it worded it', async () => {
    const { calls } = serve({
      stream: () => refused({ code: 'forbidden', message: 'That is not allowed.', status: 403 }),
    });

    await ask();

    // A refusal is an answer. Asking the same question eight times cannot turn
    // it into a different one, and every retry is a request the server has
    // already declined — so the reconnection loop is for connections, and a
    // status in the four hundreds is not one.
    expect(await screen.findByRole('alert')).toHaveTextContent(/not allowed/);
    expect(calls.filter((call) => call.includes('/stream'))).toHaveLength(1);
  });

  it('gives up on a message that is not there, rather than asking for ever', async () => {
    serve({
      stream: () =>
        refused({ code: 'not_found', message: 'That message does not exist.', status: 404 }),
    });

    await ask();

    // Deleted, or never this person's. Retrying would be a loop with an answer
    // already in hand.
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not exist/);
  });
});

describe('a question the server refuses', () => {
  it('says why, in the words the server chose', async () => {
    stubApi((url, init) => {
      if (init?.method === 'POST' && !url.includes('/stop')) {
        return refused({
          code: 'conflict',
          message: 'That conflicts with the current state. Reload and try again.',
          status: 409,
        });
      }
      return page([]);
    });

    await ask();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Reload and try again/);
  });

  it('leaves the composer ready for the next one', async () => {
    stubApi((url, init) => {
      if (init?.method === 'POST' && !url.includes('/stop')) {
        return refused({ code: 'internal', message: 'Something went wrong.', status: 500 });
      }
      return page([]);
    });

    await ask();
    await screen.findByRole('alert');

    // A failure is not busy: whatever went wrong, the next question is allowed.
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});

describe('a pod being drained', () => {
  it('attaches again without changing anything on screen', async () => {
    let attempts = 0;
    const { calls } = serve({
      stream: () => {
        attempts += 1;
        return attempts === 1
          ? eventStream([
              frame('5-0', { type: 'text_delta', delta: 'Apple earned ' }),
              frame(null, { type: 'reconnect_hint' }),
            ])
          : eventStream([frame('6-0', { type: 'text_delta', delta: '$391.0B.' })], true);
      },
    });

    await ask();

    expect(await screen.findByText(/Apple earned \$391\.0B\./)).toBeInTheDocument();
    // The hint has no position of its own, so the second attempt resumes from
    // the last event that did.
    expect(calls.filter((call) => call.includes('/stream'))).toHaveLength(2);
  });
});

describe('leaving the page', () => {
  it('lets the stream go without stopping the answer', async () => {
    const { calls } = serve({
      stream: () => eventStream([frame('1-0', { type: 'text_delta', delta: 'Apple' })], true),
    });
    const { unmount } = renderApp(<ChatRoom conversationId={ID} />);
    await screen.findByText(/Ask the first question/);
    await userEvent.type(screen.getByLabelText('Ask a question'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Apple');

    unmount();

    // Nothing is asked to stop: closing a tab says something about the tab, and
    // the answer carries on being written for whoever opens it next.
    expect(calls.filter((call) => call.includes('/stop'))).toEqual([]);
  });

  it('gives up a reconnection it was waiting to make', async () => {
    // The stream ends without a terminal event, so the page is in its backoff
    // when it goes away.
    const { calls } = serve({
      stream: () => eventStream([frame('1-0', { type: 'text_delta', delta: 'Apple' })]),
    });
    const { unmount } = renderApp(<ChatRoom conversationId={ID} />);
    await screen.findByText(/Ask the first question/);
    await userEvent.type(screen.getByLabelText('Ask a question'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/Reconnecting/);

    unmount();
    const attached = calls.filter((call) => call.includes('/stream')).length;
    await new Promise((resolve) => setTimeout(resolve, 700));

    // The wait is cut short rather than run out: a page that has gone must not
    // open a connection half a second later.
    expect(calls.filter((call) => call.includes('/stream'))).toHaveLength(attached);
  });
});

describe('a generation that failed on the server', () => {
  it('says what the server said, and nothing about how it is built', async () => {
    serve({
      stream: () =>
        eventStream([
          frame('1-0', { type: 'text_delta', delta: 'Apple' }),
          frame('2-0', {
            type: 'error',
            code: 'generation_failed',
            message: 'Something went wrong while writing the answer. Please try asking again.',
          }),
        ]),
    });

    await ask();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Please try asking again/);
  });
});

describe('a stop the server refuses', () => {
  it('leaves the answer arriving, and the button there to press again', async () => {
    const { calls } = stubApi((url, init) => {
      if (url.includes('/stream')) {
        return eventStream([frame('1-0', { type: 'text_delta', delta: 'Apple' })], true);
      }
      if (url.includes('/stop')) return refused({ code: 'internal', message: 'No.', status: 500 });
      if (init?.method === 'POST') {
        return json(
          {
            assistantMessageId: ANSWER,
            streamPath: `/api/v1/messages/${ANSWER}/stream`,
            resumed: false,
          },
          202,
        );
      }
      return page([]);
    });

    await ask();
    await screen.findByText('Apple');
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    // Turning this into a failure would clear a view that is perfectly correct:
    // the answer really is still being written.
    await waitFor(() => {
      expect(calls.some((call) => call.includes('/stop'))).toBe(true);
    });
    // A tick for the refusal to be caught. Left uncaught it would be an
    // unhandled rejection, which is a crash report for something that changed
    // nothing.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText('Apple')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });
});

describe('an answer that was already being written', () => {
  it('is attached to once, however many times the page settles', async () => {
    const { calls } = serve({
      history: () => page([answered([], 'generating')]),
      stream: () => eventStream([frame('7-0', { type: 'text_delta', delta: 'Apple' })], true),
    });

    // Every screen here renders under `StrictMode`, as the application itself
    // does: every effect is mounted, torn down and mounted again, which is
    // exactly the shape that opens a second connection to the same stream.
    renderApp(<ChatRoom conversationId={ID} />);
    await screen.findByText('Apple');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Effects run twice in development, and a second attach would read the same
    // stream from the beginning beside the first — every event dispatched twice.
    expect(calls.filter((call) => call.includes('/stream'))).toHaveLength(1);
  });
});

describe('coming back to an answer that is still being written', () => {
  it('attaches again when the room settles with the history already in hand', async () => {
    serve({
      history: () => page([answered([], 'generating')]),
      stream: () => eventStream([frame('7-0', { type: 'text_delta', delta: 'Apple' })], true),
    });
    const cache = freshCache();

    // Read once, so the second visit has the history before it renders. That is
    // what moves the attach into the mount pass — where the teardown every
    // screen goes through aborts it — instead of arriving safely afterwards.
    const first = renderApp(<ChatRoom conversationId={ID} />, '/', cache);
    await screen.findByText('Apple');
    first.unmount();

    renderApp(<ChatRoom conversationId={ID} />, '/', cache);

    // Something has to make the second attach, or the room says "Working on it"
    // for as long as it is left open.
    expect(await screen.findByText('Apple')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // And read by one connection, still: two would replay the same frame into
    // the same answer and write `AppleApple`.
    expect(screen.getByText('Apple')).toBeInTheDocument();
  });
});

describe('an unfinished answer nothing is reading', () => {
  it('is drawn without the caret that says text is arriving', async () => {
    serve({
      history: () => page([answered([{ kind: 'text', text: 'Apple earned' }], 'generating')]),
      stream: () =>
        refused({ code: 'not_found', message: 'That message does not exist.', status: 404 }),
    });

    renderApp(<ChatRoom conversationId={ID} />);
    await screen.findByRole('alert');

    // The row still says `generating`, because on the server it is — but this
    // page has stopped following it, and a blinking caret beside an alert that
    // says the connection is gone claims two opposite things at once.
    expect(screen.getByText(/Apple earned/)).toBeInTheDocument();
    expect(screen.queryByText('▍')).not.toBeInTheDocument();
  });
});

describe('reading further back in a long conversation', () => {
  /**
   * jsdom has no `IntersectionObserver`, so the sentinel is never told it has
   * come into view and the page that loads older messages never loads. Filled
   * in here — only the part the component uses — rather than making the
   * component guard for an environment.
   */
  function whenTheTopIsReached(): void {
    class Observer {
      constructor(private readonly notify: IntersectionObserverCallback) {}
      observe(): void {
        this.notify([{ isIntersecting: true } as IntersectionObserverEntry], this);
      }
      disconnect(): void {
        // Nothing to release: this stub holds no state.
      }
      unobserve(): void {
        // As above.
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = '';
      readonly scrollMargin = '';
      readonly thresholds = [];
    }
    vi.stubGlobal('IntersectionObserver', Observer);
  }

  it('asks for the page before it and reads downwards', async () => {
    whenTheTopIsReached();
    const older = {
      ...answered([{ kind: 'text', text: 'an older answer' }]),
      id: '99999999-0000-4000-8000-000000000000',
      seq: 1,
    };
    const { calls } = stubApi((url) =>
      url.includes('cursor')
        ? page([older])
        : page([answered([{ kind: 'text', text: 'the newest answer' }])], 'older'),
    );

    renderApp(<ChatRoom conversationId={ID} />);

    expect(await screen.findByText('an older answer')).toBeInTheDocument();
    expect(calls.some((call) => call.includes('cursor=older'))).toBe(true);
    // Oldest first, because that is how a transcript reads, even though the
    // newest page arrived first.
    const said = screen.getAllByText(/answer$/).map((node) => node.textContent);
    expect(said).toEqual(['an older answer', 'the newest answer']);
  });
});

describe('a connection that cannot be made at all', () => {
  it('keeps trying rather than giving up on an answer that is still being written', async () => {
    let attempts = 0;
    serve({
      stream: () => {
        attempts += 1;
        // No response at all: the tunnel, the dropped wifi, the laptop lid.
        if (attempts === 1) throw new Error('offline');
        return eventStream(
          [frame('1-0', { type: 'text_delta', delta: 'Apple earned $391.0B.' })],
          true,
        );
      },
    });

    await ask();

    expect(await screen.findByText(/Apple earned/)).toBeInTheDocument();
  });
});

describe('reading an earlier answer while a new one arrives', () => {
  it('does not drag the page back to the bottom', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollTo');
    const live = pushableStream();
    serve({ stream: () => live.response });

    await ask();
    // jsdom reports every measurement as zero, so the shape of the page has to
    // be stated before any of this means anything.
    const box = document.querySelector('.overflow-y-auto');
    Object.defineProperty(box, 'scrollHeight', { value: 2_000, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(box, 'scrollTop', { value: 1_600, configurable: true });
    live.push(frame('1-0', { type: 'text_delta', delta: 'Apple' }));
    await screen.findByText('Apple');

    // Scrolled up, away from where the room last left them: the direction is
    // what says somebody chose to read back rather than content having arrived.
    Object.defineProperty(box, 'scrollTop', { value: 200, configurable: true });
    box?.dispatchEvent(new Event('scroll'));
    scrolled.mockClear();

    live.push(frame('2-0', { type: 'text_delta', delta: ' earned $391.0B.' }));
    await screen.findByText(/Apple earned/);

    expect(scrolled).not.toHaveBeenCalled();
    scrolled.mockRestore();
  });

  it('keeps following when the page grew rather than the reader moving', async () => {
    // The case that distance alone cannot tell apart: content arriving widens
    // the gap to the bottom without anybody touching the scroll, and a rule
    // written on distance would read that as walking away.
    const scrolled = vi.spyOn(Element.prototype, 'scrollTo');
    const live = pushableStream();
    serve({ stream: () => live.response });

    await ask();
    const box = document.querySelector('.overflow-y-auto');
    Object.defineProperty(box, 'scrollHeight', { value: 2_000, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(box, 'scrollTop', { value: 1_600, configurable: true });
    live.push(frame('1-0', { type: 'text_delta', delta: 'Apple' }));
    await screen.findByText('Apple');

    // Taller, same position — which is what an answer arriving looks like.
    Object.defineProperty(box, 'scrollHeight', { value: 3_000, configurable: true });
    box?.dispatchEvent(new Event('scroll'));
    scrolled.mockClear();

    live.push(frame('2-0', { type: 'text_delta', delta: ' earned $391.0B.' }));
    await screen.findByText(/Apple earned/);

    expect(scrolled).toHaveBeenCalled();
    scrolled.mockRestore();
  });

  it('follows the end for somebody who is still at it', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollTo');
    const live = pushableStream();
    serve({ stream: () => live.response });

    await ask();
    live.push(frame('1-0', { type: 'text_delta', delta: 'Apple' }));
    await screen.findByText('Apple');
    scrolled.mockClear();

    live.push(frame('2-0', { type: 'text_delta', delta: ' earned $391.0B.' }));
    await screen.findByText(/Apple earned/);

    expect(scrolled).toHaveBeenCalled();
    scrolled.mockRestore();
  });
});

describe('the question a room was opened with', () => {
  it('is asked once, however many times the room settles', async () => {
    const { calls } = serve({
      stream: () => eventStream([frame('1-0', { type: 'text_delta', delta: 'Apple' })], true),
    });

    // Under `StrictMode`, as the application runs: every effect is mounted,
    // torn down and mounted again. Asking twice would be two answers to one
    // question — which is what a page reload used to produce, because
    // `navigate` with state writes to `history.state`, and `history.state`
    // survives a reload.
    renderApp(<ChatRoom conversationId={ID} opening="What was the revenue of Apple in 2024?" />);
    await screen.findByText('Apple');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
  });
});
