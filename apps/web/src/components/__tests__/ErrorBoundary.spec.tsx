import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '../ErrorBoundary';

function Explodes(): never {
  throw new Error('the component blew up');
}

beforeEach(() => {
  // React writes the caught error to the console itself; the assertion is the
  // rendered output, and the noise would drown the run.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('replaces the part that failed instead of blanking the page', () => {
    render(
      <div>
        <p>the rest of the page</p>
        <ErrorBoundary label="The chart">
          <Explodes />
        </ErrorBoundary>
      </div>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The chart could not be shown');
    expect(screen.getByText('the rest of the page')).toBeInTheDocument();
  });

  it('lets someone try the same part again', async () => {
    let shouldFail = true;
    function Sometimes() {
      if (shouldFail) throw new Error('not yet');
      return <p>it worked this time</p>;
    }

    render(
      <ErrorBoundary label="The chart">
        <Sometimes />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldFail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('it worked this time')).toBeInTheDocument();
  });

  it('keeps the developer detail out of the interface', () => {
    render(
      <ErrorBoundary label="The chart">
        <Explodes />
      </ErrorBoundary>,
    );

    // The message names a component and a file. It belongs in the console.
    expect(screen.queryByText(/blew up/)).toBeNull();
    // eslint-disable-next-line no-console -- asserting the detail went to the console
    expect(console.error).toHaveBeenCalled();
  });
});
