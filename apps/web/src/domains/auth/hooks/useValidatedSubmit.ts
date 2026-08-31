import { useState } from 'react';
import type { z } from 'zod';

import { rejectedFields } from '../utils/rejectedFields';

interface ValidatedSubmit {
  /** Which fields the schema turned down on the last attempt. */
  readonly rejected: ReadonlySet<string>;
  readonly submit: (values: unknown) => void;
}

/**
 * Checks a form against the same schema the server enforces, and only sends what
 * passes. Both forms need this and neither should own it, because the moment one
 * of them validates slightly differently the two screens disagree about what a
 * valid password is.
 */
export function useValidatedSubmit<T>(
  schema: z.ZodType<T>,
  send: (value: T) => void,
): ValidatedSubmit {
  const [rejected, setRejected] = useState<ReadonlySet<string>>(new Set());

  return {
    rejected,
    submit: (values) => {
      const parsed = schema.safeParse(values);
      if (!parsed.success) {
        setRejected(rejectedFields(parsed.error));
        return;
      }
      setRejected(new Set());
      send(parsed.data);
    },
  };
}
