import type { ButtonHTMLAttributes } from 'react';

import { cx } from './cx';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

/**
 * `primary` paints `ink`, not the accent. The one saturated hue in this
 * interface means "checked against the query result", and a button is not a
 * claim about data. `ink` inverts between themes so that "primary" stays a
 * single idea rather than two.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-on-ink hover:opacity-90',
  secondary: 'border border-line bg-surface text-text hover:bg-raised',
  ghost: 'text-muted hover:bg-raised hover:text-text',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

export function Button({ variant = 'secondary', className, type, ...rest }: ButtonProps) {
  return (
    <button
      // A button inside a form submits it unless told otherwise. The default is
      // a trap rather than a convenience, so it is spelled out here once.
      type={type ?? 'button'}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2',
        'text-body-sm font-medium transition-opacity',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
}
