import type { z } from 'zod';

/**
 * Which fields a schema rejected. The rule itself lives in `@fca/contracts` and
 * is the same one the server enforces; only the wording is decided here, because
 * a validator's own message is written for whoever wrote the validator.
 */
export function rejectedFields(error: z.ZodError): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string') fields.add(field);
  }
  return fields;
}
