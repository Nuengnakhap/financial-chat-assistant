import type { HTMLAttributes } from 'react';

import { cx } from './cx';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  // One shadow, one border, no nesting beyond a single level — the anti-slop
  // rules exist so surfaces stay legible instead of stacking.
  return (
    <div
      className={cx('rounded-lg border border-line bg-surface p-4 shadow-raised', className)}
      {...rest}
    />
  );
}
