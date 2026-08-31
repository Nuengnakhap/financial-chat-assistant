import { useId, type InputHTMLAttributes } from 'react';

import { cx } from '@/utils/cx';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string;
  readonly error?: string;
}

/**
 * The label, the input and the error are one component because separating them
 * makes it possible to ship an input without a label, and that is the mistake
 * this exists to prevent. The id is generated here so `htmlFor` and
 * `aria-describedby` cannot drift apart.
 *
 * The input is a rule rather than a box: the label above it and the line under
 * it are the whole control. That rule is therefore load-bearing, so it is drawn
 * in `line-strong` — the one border token that has to clear 3:1 — and darkens
 * to full ink on focus rather than changing width, which would move the text.
 */
export function Field({ label, error, className, ...rest }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const invalid = error !== undefined;

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={id}
        className="font-mono text-micro font-medium tracking-wide text-muted uppercase"
      >
        {label}
      </label>
      <input
        id={id}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : undefined}
        className={cx(
          'border-b bg-surface pb-2 text-body text-text',
          'placeholder:text-muted',
          invalid ? 'border-negative' : 'border-line-strong focus:border-text',
          className,
        )}
        {...rest}
      />
      {invalid && (
        <p id={errorId} className="text-body-sm text-negative">
          {error}
        </p>
      )}
    </div>
  );
}
