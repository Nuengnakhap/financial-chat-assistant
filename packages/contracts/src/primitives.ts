import { z } from 'zod';

export const uuid = z.uuid();
export const isoDateTime = z.iso.datetime();

/**
 * Money crosses the wire as an integer count of micro-USD in a string. JSON has
 * only doubles, so sending 0.1 USD and adding it up on the other side loses the
 * exactness the whole budget path is built to keep.
 */
export const microUsd = z.string().regex(/^-?\d+$/, 'must be an integer micro-USD string');

/** Opaque to the client: it encodes a keyset position and only the server decodes it. */
export const cursor = z.string().min(1).max(512);

export const paginationQuery = (maxLimit: number) =>
  z.object({
    cursor: cursor.optional(),
    limit: z.coerce.number().int().min(1).max(maxLimit).default(maxLimit),
  });

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: cursor.nullable() });

export const ok = z.object({ ok: z.literal(true) });

export type Ok = z.infer<typeof ok>;
