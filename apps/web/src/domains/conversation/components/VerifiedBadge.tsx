import type { GroundingReport, MessageStatus } from '@fca/contracts';

/**
 * What was done to the figures above it.
 *
 * The green badge is the only claim this interface makes on its own behalf, and
 * it is made in exactly one situation: every figure in the answer was matched
 * against a value in a query result. Anything else says something weaker, in
 * words — a badge that appeared for a fallback answer, or for one that was
 * stopped halfway, would be the whole guarantee reduced to decoration.
 *
 * The label is the sentence, not the colour. Somebody reading this with a screen
 * reader, or with a monitor that renders both greens as grey, gets the same
 * meaning as somebody looking at the dot.
 */

export interface VerifiedBadgeProps {
  readonly status: MessageStatus;
  readonly verification: GroundingReport | null;
}

export function VerifiedBadge({ status, verification }: VerifiedBadgeProps) {
  if (status === 'stopped') return <Note>Stopped before it finished</Note>;
  if (status === 'error') return <Note>This answer could not be written</Note>;
  if (verification === null) return null;

  // The verifier refused the draft and the answer was assembled from the rows
  // themselves. It is still only what the data says — which is the point — but
  // it is not the same claim, and it does not get the same badge.
  if (verification.verdict !== 'pass') return <Note>Showing verified data only</Note>;

  // An answer with no figures in it has nothing for the badge to be about. The
  // green one means "every figure was matched against a query result", and
  // saying that over a refusal — the commonest answer of this kind — would be a
  // claim about nothing.
  if (verification.checkedClaims.length === 0) return <Note>No figures to verify</Note>;

  return <Verified count={verification.checkedClaims.length} />;
}

function Verified({ count }: { readonly count: number }) {
  const figures = `${String(count)} ${count === 1 ? 'figure' : 'figures'}`;

  return (
    <p
      aria-label={`Verified: ${figures} checked against the query results`}
      className="inline-flex items-center gap-2 rounded-sm bg-verified-soft px-2 py-1 font-mono text-micro tracking-wide text-verified uppercase"
    >
      <span aria-hidden="true" className="size-2 rounded-sm bg-verified" />
      Verified · {figures} checked
    </p>
  );
}

function Note({ children }: { readonly children: string }) {
  return <p className="font-mono text-micro tracking-wide text-muted uppercase">{children}</p>;
}
