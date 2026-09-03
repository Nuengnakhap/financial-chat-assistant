import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Answer } from '../components/Answer';

/**
 * The card over a query as the model types it.
 *
 * The arguments of a tool call arrive as JSON that has not been closed yet, so
 * a card that draws them unread shows the envelope in place of the letter — and
 * one that opens before there is a statement announces a query nobody is
 * writing.
 */

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
