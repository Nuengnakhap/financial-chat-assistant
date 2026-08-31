import type { HTMLAttributes } from 'react';

import { cx } from '@/utils/cx';

/**
 * `aria-hidden` on purpose: a screen reader announcing a placeholder shape is
 * noise. The surface that owns the skeleton is what says it is loading.
 */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cx('animate-pulse rounded-sm bg-raised', className)}
      {...rest}
    />
  );
}
