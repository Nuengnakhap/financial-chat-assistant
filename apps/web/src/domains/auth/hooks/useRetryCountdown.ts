import { useEffect, useState } from 'react';

import { retryAfterSeconds } from '@/lib/api/errors';

/**
 * Seconds left before a rate-limited form may be submitted again, counted from
 * the `Retry-After` the server sent. Zero means there is nothing to wait for.
 *
 * The starting number is taken while rendering rather than from an effect: it is
 * a function of the error, and an effect would render once with the old value
 * before correcting itself. The effect does the one thing only an effect can —
 * run the clock — and stops as soon as there is nothing left to count.
 *
 * The error object is what it watches, not the number: two refusals ten seconds
 * apart carry the same value, and keying on that would leave the second one
 * showing a countdown that had already run out.
 */
export function useRetryCountdown(error: unknown): number {
  const [watched, setWatched] = useState(error);
  // Seeded from the first error too, not only from a change: a hook mounted with
  // a refusal already in hand would otherwise show no clock at all.
  const [remaining, setRemaining] = useState(() => retryAfterSeconds(error) ?? 0);

  if (watched !== error) {
    setWatched(error);
    setRemaining(retryAfterSeconds(error) ?? 0);
  }

  const counting = remaining > 0;

  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => {
      setRemaining((left) => (left <= 1 ? 0 : left - 1));
    }, 1_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [counting]);

  return remaining;
}
