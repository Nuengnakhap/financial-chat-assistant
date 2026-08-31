import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useRetryCountdown } from '../hooks/useRetryCountdown';

import { ApiError } from '@/lib/api/errors';

afterEach(() => {
  vi.useRealTimers();
});

describe('the countdown', () => {
  it('runs down to zero and stops', () => {
    vi.useFakeTimers();
    const rateLimited = new ApiError({
      code: 'rate_limited',
      status: 429,
      message: 'Too many attempts.',
      retryAfterSeconds: 3,
    });

    const { result } = renderHook(() => useRetryCountdown(rateLimited));
    expect(result.current).toBe(3);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(result.current).toBe(0);
  });

  it('has nothing to count when the failure carries no wait', () => {
    const { result } = renderHook(() => useRetryCountdown(new Error('boom')));

    expect(result.current).toBe(0);
  });
});
