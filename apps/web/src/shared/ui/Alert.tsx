import type { ReactNode } from 'react';

import { cx } from './cx';

export type AlertTone = 'info' | 'positive' | 'warning' | 'negative';

/**
 * The text is always `--color-text` on a soft background, never the tone colour
 * on the tone colour. Coloured text on a tinted surface is where contrast
 * quietly fails, and the tone still reads: it carries the left edge.
 */
const TONE: Record<AlertTone, { readonly surface: string; readonly edge: string }> = {
  info: { surface: 'bg-raised', edge: 'border-l-verified' },
  positive: { surface: 'bg-positive-soft', edge: 'border-l-positive' },
  warning: { surface: 'bg-warning-soft', edge: 'border-l-warning' },
  negative: { surface: 'bg-negative-soft', edge: 'border-l-negative' },
};

export interface AlertProps {
  readonly tone?: AlertTone;
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Alert({ tone = 'info', title, children, className }: AlertProps) {
  const { surface, edge } = TONE[tone];

  return (
    <div
      // Only a failure interrupts. Anything else waits its turn in the queue.
      role={tone === 'negative' ? 'alert' : 'status'}
      className={cx(
        'rounded-md border-l-4 px-4 py-3 text-body-sm text-text',
        surface,
        edge,
        className,
      )}
    >
      {title !== undefined && <p className="font-medium">{title}</p>}
      {children}
    </div>
  );
}
