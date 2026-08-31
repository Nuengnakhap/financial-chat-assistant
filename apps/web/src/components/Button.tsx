import type { ButtonHTMLAttributes } from 'react';

import { cx } from '@/utils/cx';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'sm' | 'md';

/**
 * `primary` paints `ink`, not the accent. The one saturated hue in this
 * interface means "checked against the query result", and a button is not a
 * claim about data. `ink` inverts between themes so that "primary" stays a
 * single idea rather than two.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-on-ink hover:opacity-90',
  // `line`, not `line-strong`: a button carries its own label, so the border is
  // not what tells anyone the control is there. An empty input has nothing but
  // its edge, which is why `Field` uses the stronger one.
  secondary: 'border border-line bg-surface text-text hover:bg-raised',
  ghost: 'text-muted hover:bg-raised hover:text-text',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-3 py-2 text-body-sm',
  md: 'px-6 py-3 text-body-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button
      // A button inside a form submits it unless told otherwise. The default is
      // a trap rather than a convenience, so it is spelled out here once.
      type={type ?? 'button'}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md',
        'font-medium transition-opacity',
        'disabled:cursor-not-allowed disabled:opacity-50',
        SIZE[size],
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
}
