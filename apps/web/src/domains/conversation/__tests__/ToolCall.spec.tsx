import type { MessagePart } from '@fca/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolCall, WritingQuery } from '../components/ToolCall';

/**
 * The query behind an answer. It is the part of the screen that makes the
 * guarantee checkable rather than merely stated, so what matters is that it
 * shows the statement that ran and the rows that came back — including when
 * they came back empty, or not at all.
 */

const CALL: Extract<MessagePart, { kind: 'tool_call' }> = {
  kind: 'tool_call',
  id: 'call_1',
  sql: "SELECT company, revenue FROM financial_data WHERE company = 'Apple'",
};

type Result = Extract<MessagePart, { kind: 'tool_result' }>;

const result = (over: Partial<Result> = {}): Result => ({
  kind: 'tool_result',
  toolCallId: 'call_1',
  rowCount: 1,
  preview: [{ company: 'Apple', revenue: '391035000000' }],
  elapsedMs: 4,
  error: null,
  ...over,
});

describe('a query that has run', () => {
  it('shows the statement and what it cost', () => {
    render(<ToolCall call={CALL} result={result()} />);

    expect(screen.getByText(/SELECT company, revenue FROM financial_data/)).toBeInTheDocument();
    expect(screen.getByText(/1 row · 4ms/)).toBeInTheDocument();
  });

  it('counts more than one row as rows', () => {
    render(
      <ToolCall
        call={CALL}
        result={result({
          rowCount: 3,
          preview: [{ company: 'Apple' }, { company: 'Amazon' }, { company: 'Alphabet' }],
        })}
      />,
    );

    expect(screen.getByText(/3 rows · 4ms/)).toBeInTheDocument();
  });

  it('says how much of a long result is being shown', () => {
    render(<ToolCall call={CALL} result={result({ rowCount: 50 })} />);

    // The preview is capped at twenty rows on the wire. A table that silently
    // showed one of fifty would read as the whole answer.
    expect(screen.getByText(/Showing 1 of 50 rows/)).toBeInTheDocument();
  });

  it('does not say so when the preview is the whole result', () => {
    render(<ToolCall call={CALL} result={result()} />);

    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it('says a missing figure is missing rather than leaving a blank', () => {
    render(
      <ToolCall
        call={CALL}
        result={result({ preview: [{ company: 'Wells Fargo', revenue: null }] })}
      />,
    );

    // Nothing recorded is a fact about this dataset. An empty cell reads as a
    // rendering fault.
    expect(screen.getByTitle('Not recorded in this dataset')).toHaveTextContent('—');
  });

  it('is still open while it is running, and closed once it is not', () => {
    const { rerender, container } = render(<ToolCall call={CALL} result={undefined} />);
    expect(container.querySelector('details')).toHaveAttribute('open');
    expect(screen.getByText(/running/)).toBeInTheDocument();

    rerender(<ToolCall call={CALL} result={result()} />);

    // A finished query is provenance rather than progress: there when it is
    // wanted, and out of the way of the answer when it is not.
    expect(container.querySelector('details')).not.toHaveAttribute('open');
  });
});

describe('a query that came back with nothing', () => {
  it('says so, rather than showing an empty table', () => {
    render(<ToolCall call={CALL} result={result({ rowCount: 0, preview: [] })} />);

    expect(screen.getByText(/No rows matched/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('a query the policy refused', () => {
  it('shows the reason, so a refusal is visible rather than silent', () => {
    render(
      <ToolCall
        call={CALL}
        result={result({
          error: 'Two result columns are called "sum"; give each one a name with AS.',
        })}
      />,
    );

    expect(screen.getByText(/refused/)).toBeInTheDocument();
    expect(screen.getByText(/give each one a name with AS/)).toBeInTheDocument();
  });
});

describe('a query still being written', () => {
  it('shows it taking shape', () => {
    render(<WritingQuery sql='{"sql":"SELECT reven' />);

    expect(screen.getByText(/Writing a query/)).toBeInTheDocument();
    expect(screen.getByText(/SELECT reven/)).toBeInTheDocument();
  });
});
