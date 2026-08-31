import type { ReactNode } from 'react';

import { cx } from '@/utils/cx';

type AlertTone = 'info' | 'positive' | 'warning' | 'negative';

/**
 * A rule and a sentence, with no fill behind it. A tinted panel is the loudest
 * thing on a quiet page, and a failed sign-in does not deserve to outrank the
 * form it is about. The tone lives entirely in the left rule, and the text is
 * always `--color-text` — coloured text on a tinted surface is where contrast
 * quietly fails.
 */
const TONE: Record<AlertTone, string> = {
  info: 'border-l-line-strong',
  positive: 'border-l-positive',
  warning: 'border-l-warning',
  negative: 'border-l-negative',
};

export interface AlertProps {
  readonly tone?: AlertTone;
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Alert({ tone = 'info', title, children, className }: AlertProps) {
  return (
    <div
      // Only a failure interrupts. Anything else waits its turn in the queue.
      role={tone === 'negative' ? 'alert' : 'status'}
      className={cx('border-l-2 pl-3 text-body-sm text-text', TONE[tone], className)}
    >
      {title !== undefined && <p className="font-medium">{title}</p>}
      {children}
    </div>
  );
}
