import type { GroundingReport } from '@fca/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { VerifiedBadge } from '../components/VerifiedBadge';

/**
 * The one claim this interface makes on its own behalf. Everything else on the
 * screen is either the model's words or the database's rows; this is the
 * application saying "we checked", so the rule it exists to hold is that it says
 * so in exactly one situation and never in any other.
 */

const passed: GroundingReport = {
  verdict: 'pass',
  checkedClaims: [
    {
      text: '$391.0B',
      value: '391035000000',
      toolCallId: 'call_1',
      rowIndex: 0,
      column: 'revenue',
    },
    {
      text: '$97.0B',
      value: '96995000000',
      toolCallId: 'call_1',
      rowIndex: 0,
      column: 'net_income',
    },
  ],
  violations: [],
};

const failed: GroundingReport = {
  verdict: 'fail',
  checkedClaims: [],
  violations: [{ text: '$400B', reason: 'no_evidence' }],
};

const badge = (): HTMLElement | null => screen.queryByLabelText(/^Verified:/);

describe('an answer whose every figure was matched', () => {
  it('says so, and says how many', () => {
    render(<VerifiedBadge status="complete" verification={passed} />);

    expect(
      screen.getByLabelText('Verified: 2 figures checked against the query results'),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 figures checked/)).toBeInTheDocument();
  });

  it('counts one figure as a figure', () => {
    render(
      <VerifiedBadge
        status="complete"
        verification={{ ...passed, checkedClaims: passed.checkedClaims.slice(0, 1) }}
      />,
    );

    expect(screen.getByText(/1 figure checked/)).toBeInTheDocument();
  });
});

describe('an answer that was not verified', () => {
  it('gets no badge when the verifier refused the draft', () => {
    render(<VerifiedBadge status="complete" verification={failed} />);

    // The answer was assembled from the rows themselves. It is still only what
    // the data says, which is the point — but it is not the same claim.
    expect(badge()).not.toBeInTheDocument();
    expect(screen.getByText(/Showing verified data only/)).toBeInTheDocument();
  });

  it('gets no badge when it was stopped halfway', () => {
    render(<VerifiedBadge status="stopped" verification={null} />);

    expect(badge()).not.toBeInTheDocument();
    expect(screen.getByText(/Stopped before it finished/)).toBeInTheDocument();
  });

  it('gets no badge when it failed', () => {
    render(<VerifiedBadge status="error" verification={null} />);

    expect(badge()).not.toBeInTheDocument();
    expect(screen.getByText(/could not be written/)).toBeInTheDocument();
  });

  it('gets no badge for an answer that had no figures in it', () => {
    // A refusal is the commonest answer of this kind: it was checked, and what
    // it was checked for was that no figure was invented.
    render(<VerifiedBadge status="complete" verification={{ ...passed, checkedClaims: [] }} />);

    expect(badge()).not.toBeInTheDocument();
    expect(screen.getByText(/No figures to verify/)).toBeInTheDocument();
  });

  it('gets no badge, and says nothing at all, while it is still being written', () => {
    const { container } = render(<VerifiedBadge status="generating" verification={null} />);

    // A claim about an answer that is not finished is a claim about nothing.
    expect(container).toBeEmptyDOMElement();
  });

  it('gets no badge even for a stopped answer that had passed so far', () => {
    // The report is about the draft, and the draft was cut off. Nothing checked
    // the answer that is actually stored.
    render(<VerifiedBadge status="stopped" verification={passed} />);

    expect(badge()).not.toBeInTheDocument();
  });
});
