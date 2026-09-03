import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLiveText } from '../useLiveText';

/**
 * The two things the claim gate does to a reader, and what this undoes.
 *
 * Prose leaves the gate a few characters at a time; a table and a fenced block
 * leave it whole, because a leading-cell rank needs the row count and a fence
 * means whatever its closing line says. A ranking answer therefore arrives as a
 * heading, then a silence, then fifteen hundred characters at once.
 *
 * Neither is a bug on the server. Both are unreadable on a screen.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an answer nobody is watching arrive', () => {
  it('is shown whole, with no reveal and no waiting', () => {
    const { result } = renderHook(() => useLiveText('x'.repeat(2_000), false));

    expect(result.current.shown).toHaveLength(2_000);
    expect(result.current.waiting).toBe(false);
  });
});

describe('an ordinary delta', () => {
  it('lands in the next frame, which is as good as at once', () => {
    const { result, rerender } = renderHook(({ text }) => useLiveText(text, true), {
      initialProps: { text: 'Nvidia' },
    });

    rerender({ text: 'Nvidia revenue rose' });
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // A few characters are already smooth: the reveal exists for the bursts,
    // and a step big enough to swallow an ordinary delta whole is what keeps it
    // from turning a stream into a typewriter.
    expect(result.current.shown).toBe('Nvidia revenue rose');
  });
});

describe('a burst — a whole table leaving the gate at once', () => {
  // The size the gate actually released in one frame, measured on a real answer.
  const table = `| Rank | Company | Ticker | Revenue |\n${'| 1 | Walmart | WMT | $642.6B |\n'.repeat(55)}`;

  it('does not land in a single frame', () => {
    const { result, rerender } = renderHook(({ text }) => useLiveText(text, true), {
      initialProps: { text: 'Ranking:' },
    });

    rerender({ text: `Ranking:${table}` });

    expect(result.current.shown).toBe('Ranking:');
    expect(table.length).toBeGreaterThan(200);
  });

  it('arrives in full, and quickly — the wait before it was the long part', () => {
    const { result, rerender } = renderHook(({ text }) => useLiveText(text, true), {
      initialProps: { text: 'Ranking:' },
    });

    rerender({ text: `Ranking:${table}` });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const halfway = result.current.shown.length;

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(halfway).toBeGreaterThan('Ranking:'.length);
    expect(halfway).toBeLessThan(`Ranking:${table}`.length);
    expect(result.current.shown).toBe(`Ranking:${table}`);
  });

  it('starts over rather than appending when a draft was discarded', () => {
    const { result, rerender } = renderHook(({ text }) => useLiveText(text, true), {
      initialProps: { text: 'A first draft that was thrown away' },
    });

    rerender({ text: 'Written again' });
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current.shown).toBe('Written again');
  });
});

describe('a silence', () => {
  it('is reported once it is longer than a pause between deltas', () => {
    const { result } = renderHook(() => useLiveText('Ranking:', true));

    expect(result.current.waiting).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    // Thirteen seconds of nothing is what a held table looks like from here.
    expect(result.current.waiting).toBe(true);
  });

  it('stops being reported the moment something arrives', () => {
    const { result, rerender } = renderHook(({ text }) => useLiveText(text, true), {
      initialProps: { text: 'Ranking:' },
    });
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    rerender({ text: 'Ranking: Nvidia' });

    expect(result.current.waiting).toBe(false);
  });

  it('is not reported while a burst is still being revealed', () => {
    const { result, rerender } = renderHook(({ text }) => useLiveText(text, true), {
      initialProps: { text: 'Ranking:' },
    });

    rerender({ text: `Ranking:${'| a | b |\n'.repeat(40)}` });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.waiting).toBe(false);
  });
});
