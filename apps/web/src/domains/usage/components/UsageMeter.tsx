import type { UsageView } from '@fca/contracts';

import { useUsage } from '../api/usage';
import { asDollars, shareUsed } from '../utils/amounts';

/**
 * What this hour has cost, beside what it is allowed to.
 *
 * A bar rather than a number alone, because the question somebody actually has
 * is "how much room is left", and that is a proportion. The number is there too
 * — a bar alone cannot say whether the remainder is a cent or a dollar.
 */
const NEARLY_FULL = 0.8;

export function UsageMeter() {
  const usage = useUsage();
  // Nothing until it is known. A meter that starts at zero and jumps is worse
  // than a space that fills in, because the zero is a figure and it is wrong.
  if (usage === undefined) return null;

  return <Meter usage={usage} />;
}

function Meter({ usage }: { readonly usage: UsageView }) {
  const share = shareUsed(usage);
  const spent = asDollars(usage.spentMicroUsd);
  const limit = asDollars(usage.limitMicroUsd);

  return (
    <div
      className="flex items-center gap-3"
      title={`Resets at ${new Date(usage.resetAt).toLocaleTimeString()}`}
    >
      <div
        role="meter"
        aria-label="Usage this period"
        aria-valuenow={Math.round(share * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${spent} of ${limit} used`}
        className="h-1 w-24 overflow-hidden rounded-sm bg-raised"
      >
        <div
          className={`h-full ${fillFor(share)}`}
          /* eslint-disable-next-line local-tokens/no-off-token-styles -- a proportion is not a
             token: it is the number this component exists to show, and it changes with every
             answer. */
          style={{ width: `${String(Math.round(share * 100))}%` }}
        />
      </div>
      <p className="fin-num font-mono text-micro text-muted">
        {spent} / {limit}
      </p>
    </div>
  );
}

/**
 * Colour is the last thing to say it, not the only one: the figures beside the
 * bar already do. Amber is a warning that the next answer may not fit, and the
 * negative colour means one certainly will not.
 */
function fillFor(share: number): string {
  if (share >= 1) return 'bg-negative';

  return share >= NEARLY_FULL ? 'bg-warning' : 'bg-ink';
}
