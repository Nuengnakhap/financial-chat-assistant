import { useEffect, useState } from 'react';

import { useReadsUsageAgain, useUsage } from '../api/usage';
import { timeUntil } from '../utils/amounts';

/**
 * The window is spent, and when it will not be.
 *
 * It counts down rather than saying "later" because the one thing somebody
 * wants to know is whether to wait or to go away — and it unlocks itself when
 * the time comes, since a person who has waited should not have to reload to
 * find out that they were right to.
 */
const A_SECOND = 1_000;

export function BudgetBanner() {
  const usage = useUsage();
  const readAgain = useReadsUsageAgain();
  const now = useTicksWhile(usage?.exceeded === true);

  useEffect(() => {
    if (!usage?.exceeded) return;
    if (new Date(usage.resetAt).getTime() > now) return;

    // The window has turned over. One read, and the banner goes on its own.
    readAgain();
  }, [usage, now, readAgain]);

  if (!usage?.exceeded) return null;

  return (
    <div
      role="status"
      className="flex animate-slide-down items-center justify-between gap-4 border-b border-line bg-raised px-8 py-3"
    >
      <p className="text-body-sm">
        You have reached your usage limit for this period. Asking is available again in{' '}
        <span className="fin-num font-medium">{timeUntil(usage.resetAt, now)}</span>.
      </p>
    </div>
  );
}

/**
 * A clock that only runs while somebody is waiting on it. Left running it would
 * re-render the whole shell once a second for the entire time an application is
 * open, to move a number nobody is looking at.
 */
function useTicksWhile(waiting: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!waiting) return;

    const timer = setInterval(() => {
      setNow(Date.now());
    }, A_SECOND);

    return () => {
      clearInterval(timer);
    };
  }, [waiting]);

  return now;
}
