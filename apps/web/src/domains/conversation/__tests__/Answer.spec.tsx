import type { MessagePart } from '@fca/contracts';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Answer } from '../components/Answer';

/**
 * The line that explains a silence, and the two places it must not appear.
 *
 * The claim gate holds a table and a fenced block whole, so an answer can stop
 * changing for ten seconds while it is being written. Saying so turns a screen
 * that looks broken into one that is explaining itself — but only where a held
 * block would be. A silence before anything has been written is the model
 * thinking, and a silence while a query is being typed is the card above it.
 */

const TEXT: MessagePart = { kind: 'text', text: '## Ranking by revenue' };
const CALL: MessagePart = { kind: 'tool_call', id: 'call-1', sql: 'SELECT revenue FROM t' };

function passTheQuietTime(): void {
  act(() => {
    vi.advanceTimersByTime(2_000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a silence while an answer is being written', () => {
  it('is explained once prose has stopped mid-answer', () => {
    render(<Answer parts={[TEXT]} status="generating" verification={null} live />);

    passTheQuietTime();

    expect(screen.getByText(/Still writing/i)).toBeInTheDocument();
  });

  it('says nothing before a word has been written', () => {
    // `parts` is empty here and the last text is at index -1, which is also
    // `parts.length - 1`. Seen in a browser: the line sat under "Writing a
    // query" while the model was still typing its arguments, claiming a table
    // was being held when nothing had been written at all.
    render(<Answer parts={[]} status="generating" verification={null} live writingArgs='{"sql' />);

    passTheQuietTime();

    expect(screen.queryByText(/Still writing/i)).not.toBeInTheDocument();
  });

  it('says nothing while the query itself is still being typed', () => {
    // The card above is streaming `SELECT ROW_NUMBER() OVER (…` one character
    // at a time, which took thirteen seconds on a measured answer — long past
    // the quiet time. Two lines then claim the screen at once, and the one that
    // says "nothing shows" is standing next to something being shown.
    render(
      <Answer
        parts={[TEXT]}
        status="generating"
        verification={null}
        live
        writingArgs='{"sql":"SELECT ROW_NUMBER'
      />,
    );

    passTheQuietTime();

    expect(screen.getByText(/SELECT ROW_NUMBER/)).toBeInTheDocument();
    expect(screen.queryByText(/Still writing/i)).not.toBeInTheDocument();
  });

  it('says nothing while a query is the last thing that happened', () => {
    render(<Answer parts={[TEXT, CALL]} status="generating" verification={null} live />);

    passTheQuietTime();

    expect(screen.queryByText(/Still writing/i)).not.toBeInTheDocument();
  });

  it('says nothing on an answer nobody is watching arrive', () => {
    render(<Answer parts={[TEXT]} status="generating" verification={null} />);

    passTheQuietTime();

    expect(screen.queryByText(/Still writing/i)).not.toBeInTheDocument();
  });
});

describe('the card for a query being typed', () => {
  it('waits for the statement rather than announcing an empty one', () => {
    // The first deltas of a tool call are `{`, `{"`, `{"sq` — a card headed
    // "Writing a query" over an empty box, for a frame or two, every time.
    render(<Answer parts={[]} status="generating" verification={null} live writingArgs='{"sq' />);

    expect(screen.queryByText(/Writing a query/i)).not.toBeInTheDocument();
  });

  it('stays away for a tool whose arguments hold no query at all', () => {
    // `describe_coverage` takes `{}`, and `writing-sql.ts` says out loud that a
    // card announcing a query it does not have would be a lie.
    render(<Answer parts={[]} status="generating" verification={null} live writingArgs="{}" />);

    expect(screen.queryByText(/Writing a query/i)).not.toBeInTheDocument();
  });

  it('appears as soon as there is a statement to show', () => {
    render(
      <Answer parts={[]} status="generating" verification={null} live writingArgs='{"sql":"SEL' />,
    );

    expect(screen.getByText(/Writing a query/i)).toBeInTheDocument();
    expect(screen.getByText(/SEL/)).toBeInTheDocument();
    // The envelope stays off the screen: what a person saw before this was
    // `{"sql":"SELECT ROW_NUMBER` under a card headed "Writing a query".
    expect(screen.queryByText(/\{"sql"/)).not.toBeInTheDocument();
  });
});

describe('a burst of text', () => {
  it('is revealed rather than drawn in one frame', () => {
    // The wiring, not the reveal itself: the hook is proven in its own spec.
    // What this catches is `shown` not reaching the part that is growing, which
    // puts the whole table on screen in a single frame — the thing the reveal
    // exists to stop.
    const table = `| Rank | Company |\n${'| 1 | Walmart |\n'.repeat(40)}`;
    const { rerender } = render(
      <Answer
        parts={[{ kind: 'text', text: 'Ranking:' }]}
        status="generating"
        verification={null}
        live
      />,
    );

    rerender(
      <Answer
        parts={[{ kind: 'text', text: `Ranking:\n\n${table}` }]}
        status="generating"
        verification={null}
        live
      />,
    );

    expect(screen.queryByText(/Walmart/)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getAllByText(/Walmart/).length).toBeGreaterThan(0);
  });
});
