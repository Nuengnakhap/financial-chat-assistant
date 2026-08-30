import { ValidationError } from '@fca/domain';
import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * The one place an untrusted body becomes a typed value. The schema comes from
 * `@fca/contracts`, so a handler is bound to the same definition the client
 * builds its request from rather than to a DTO that can drift from it.
 *
 * Failing with a `ValidationError` rather than Nest's own exception keeps the
 * answer inside `DomainErrorFilter`: the caller gets the wording written for a
 * person, and zod's field-by-field complaint stays in the log.
 */
export class ZodBody<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;

    // Paths only — a message here would quote what was sent, and what was sent
    // to `/auth/login` is a password.
    throw new ValidationError('Request body did not match the contract.', {
      fields: parsed.error.issues.map((issue) => issue.path.join('.')).join(','),
    });
  }
}
