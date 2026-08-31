import { describe, expect, it } from 'vitest';

import { formatWhen } from '../datetime';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

function ago(milliseconds: number): string {
  return new Date(NOW - milliseconds).toISOString();
}

describe('how long ago something was used', () => {
  it('calls the last minute the present', () => {
    expect(formatWhen(ago(30_000), NOW)).toBe('just now');
  });

  it('counts in minutes, then hours, then days', () => {
    expect(formatWhen(ago(5 * 60_000), NOW)).toBe('5 minutes ago');
    expect(formatWhen(ago(3 * 3_600_000), NOW)).toBe('3 hours ago');
    expect(formatWhen(ago(3 * 86_400_000), NOW)).toBe('3 days ago');
  });

  it('stops being relative once a week has passed', () => {
    // "37 days ago" is a number to decode. A date is read.
    const older = formatWhen(ago(37 * 86_400_000), NOW);

    expect(older).not.toMatch(/ago/);
    expect(older).toMatch(/2026/);
  });

  it('reads a clock that runs ahead of ours as the present', () => {
    // Two machines disagreeing by a few seconds must not produce "in 4 seconds"
    // beside a device someone is looking at right now.
    expect(formatWhen(new Date(NOW + 4_000).toISOString(), NOW)).toBe('just now');
  });
});
