import type { ComponentPropsWithRef } from 'react';

import { cx } from '@/utils/cx';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
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
  // A variant rather than `text-negative` passed in by a caller: two utilities
  // setting the same property are decided by their order in the stylesheet,
  // which Tailwind chooses, not by the order they were written in — so an
  // override wins or loses by luck. The shape is `secondary`'s, because a fill
  // would be a second one in an interface whose only fill is `ink`.
  danger: 'border border-line bg-surface text-negative hover:bg-raised',
  ghost: 'text-muted hover:bg-raised hover:text-text',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-3 py-2 text-body-sm',
  md: 'px-6 py-3 text-body-sm',
};

/**
 * `ComponentPropsWithRef` rather than the attributes alone: React 19 hands `ref`
 * to a function component as an ordinary prop, and anything that has to point at
 * a button — a menu measuring where to open — needs it to be in the type.
 */
export interface ButtonProps extends ComponentPropsWithRef<'button'> {
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
