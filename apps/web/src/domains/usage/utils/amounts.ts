import type { UsageView } from '@fca/contracts';

/**
 * Money as somebody reads it, from money as the wire carries it.
 *
 * The wire carries an integer count of micro-USD in a string, because JSON has
 * only doubles and a budget that arrives as `0.0014` has already lost the
 * exactness the whole path is built to keep. Dividing happens here, once, at
 * the last possible moment — and only for display.
 */
const MICRO_PER_USD = 1_000_000n;
const CENTS_PER_USD = 100n;

export function asDollars(micro: string): string {
  const amount = BigInt(micro);
  // Rounded up to the cent it is inside: showing `$0.00` for money that has
  // been spent reads as a meter that does not work.
  const cents = (amount * CENTS_PER_USD + MICRO_PER_USD - 1n) / MICRO_PER_USD;
  const whole = cents / CENTS_PER_USD;
  const rest = cents % CENTS_PER_USD;

  return `$${whole.toString()}.${rest.toString().padStart(2, '0')}`;
}

/** How full the window is, between nothing and all of it. */
export function shareUsed(usage: UsageView): number {
  const limit = BigInt(usage.limitMicroUsd);
  // A limit of nothing is a window with no room in it at all, which is full
  // rather than a division by zero.
  if (limit <= 0n) return 1;

  const used = BigInt(usage.spentMicroUsd) + BigInt(usage.reservedMicroUsd);

  return Math.min(1, Math.max(0, Number(used) / Number(limit)));
}

/**
 * How long until the window starts again, in the words a countdown uses.
 * Seconds below a minute, because at that point somebody is watching it.
 */
export function timeUntil(resetAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((new Date(resetAt).getTime() - now) / 1_000));
  if (seconds >= 3_600) {
    const hours = Math.ceil(seconds / 3_600);

    return `${String(hours)} hour${hours === 1 ? '' : 's'}`;
  }
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);

    return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  }

  return `${String(seconds)} second${seconds === 1 ? '' : 's'}`;
}
