import { useId, type InputHTMLAttributes } from 'react';

import { cx } from './cx';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string;
  readonly error?: string;
}

/**
 * The label, the input and the error are one component because separating them
 * makes it possible to ship an input without a label, and that is the mistake
 * this exists to prevent. The id is generated here so `htmlFor` and
 * `aria-describedby` cannot drift apart.
 */
export function Field({ label, error, className, ...rest }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const invalid = error !== undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-body-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : undefined}
        className={cx(
          'rounded-md border bg-surface px-3 py-2 text-body text-text',
          'placeholder:text-muted',
          // `line-strong`, not `line`: the edge is what identifies a control,
          // so it is the one token here that has to clear 3:1.
          invalid ? 'border-negative' : 'border-line-strong',
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
