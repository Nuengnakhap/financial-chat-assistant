/**
 * How a figure reads on an axis or in a tooltip.
 *
 * Only there. Inside the answer itself the model copies the `display` string the
 * server produced from the row, and the verifier checked that string against the
 * value behind it — formatting a number again here would put a figure on screen
 * that nothing has matched. A chart axis has no such string to copy, because
 * the axis is drawn from the raw values.
 */

const UNITS = [
  { at: 1_000_000_000_000, suffix: 'T' },
  { at: 1_000_000_000, suffix: 'B' },
  { at: 1_000_000, suffix: 'M' },
  { at: 1_000, suffix: 'K' },
] as const;

export function compactUsd(value: unknown): string {
  // `Number(null)` is zero and `Number('')` is zero, so a missing figure would
  // read as none at all — which on an axis is a claim rather than a gap.
  if (value === null || value === undefined || value === '') return '—';

  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';

  const size = Math.abs(amount);
  const unit = UNITS.find((candidate) => size >= candidate.at);
  if (unit === undefined) return `$${String(Math.round(amount))}`;

  const scaled = amount / unit.at;

  // One decimal below ten, none above: `$391.0B` and `$1.2T` read at a glance,
  // and `$1234.5B` reads as neither a number nor a size.
  return `$${Math.abs(scaled) < 10 ? scaled.toFixed(1) : String(Math.round(scaled))}${unit.suffix}`;
}
