const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * "3 hours ago" rather than a timestamp. The question a list of signed-in
 * devices answers is "is that still me?", and nobody turns
 * `2026-08-30T14:25:11Z` into that in their head.
 *
 * Past a week it stops being relative: "37 days ago" is a number to decode,
 * where a date is just read. `now` is a parameter so the wording can be tested
 * at a fixed instant instead of at whatever moment the suite happens to run.
 */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  // A clock a little ahead of ours reads as the present rather than the future.
  const elapsed = Math.max(now - at.getTime(), 0);

  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return ago(Math.round(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return ago(Math.round(elapsed / HOUR), 'hour');
  if (elapsed < WEEK) return ago(Math.round(elapsed / DAY), 'day');
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(at);
}

function ago(amount: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-amount, unit);
}
