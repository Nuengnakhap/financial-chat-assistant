import { ConversationId, Err, Ok, ValidationError, type Result } from '@fca/domain';
import { z } from 'zod';

/**
 * Paging is by keyset, never by offset. `OFFSET n` still reads and throws away
 * n rows — measured on 50,000 conversations, the page at offset 25,000 touched
 * 605 buffers against 4 for the keyset form — but the reason that matters more
 * is correctness: a row inserted while someone reads shifts every later offset
 * by one, so a conversation is shown twice or never shown at all.
 */

export interface Page<TItem, TCursor> {
  readonly items: readonly TItem[];
  /** `null` exactly when the database had nothing further to give. */
  readonly nextCursor: TCursor | null;
}

export interface PageRequest<TCursor> {
  readonly limit: number;
  readonly cursor: TCursor | null;
}

/**
 * A cursor is a position, not a permission. Nothing in it widens what the
 * caller may read: every query still filters on the owner, which comes from the
 * session and never from here.
 */
export interface CursorCodec<T> {
  readonly encode: (position: T) => string;
  readonly decode: (raw: string) => Result<T, ValidationError>;
}

export interface ConversationCursor {
  readonly updatedAt: Date;
  readonly id: ConversationId;
}

export interface MessageCursor {
  readonly seq: number;
}

/** Neither an ISO instant nor a UUID contains it, so the join stays unambiguous. */
const SEPARATOR = '|';

function encode(parts: readonly string[]): string {
  return Buffer.from(parts.join(SEPARATOR), 'utf8').toString('base64url');
}

/**
 * There is deliberately no `try` around this. `Buffer.from(raw, 'base64url')`
 * does not reject input that is not base64 — it drops the characters it cannot
 * read and returns whatever is left. All eight tampered cursors tried against
 * it decoded silently, including one altered by a single character, which came
 * back still shaped like a real cursor. A `catch` here would be a branch that
 * can never run while the malformed value walked on into the query.
 *
 * So the whole check is on the decoded value, and the schemas below are it.
 */
function partsOf(raw: string): readonly string[] {
  return Buffer.from(raw, 'base64url').toString('utf8').split(SEPARATOR);
}

/**
 * Both schemas below stop at what the *column* holds, not at what JavaScript
 * can represent. The difference is not pedantry: a cursor's value goes straight
 * into a query, and each of these was measured reaching PostgreSQL and being
 * refused there when the bound was the language's —
 *
 *     seq 2147483648   →  value "2147483648" is out of range for type integer
 *     -271821-04-20T…  →  timestamp out of range: "271822-04-20T… BC"
 *
 * — as a driver error rather than a `DomainError`, so a string the caller chose
 * came back as a 500. This module claims to be the whole check on a cursor, and
 * that is only true while the bound it enforces is the database's.
 */

/**
 * `toISOString` writes exactly this 24-character form for every year the column
 * can hold, and an expanded `+275760-…` or `-271821-…` for the two extremes it
 * cannot — so matching the shape is the range check. The round trip is the
 * second half: it refuses a date that merely parses, such as
 * `2026-8-31T00:00:00.000Z`, which V8 reads happily and which would page from a
 * different instant than the one written.
 */
const canonicalInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((raw) => {
    // A shape the regex allows can still be nonsense — `9999-99-99T…` — and
    // `toISOString` throws on an invalid date rather than returning something.
    const at = new Date(raw);
    return !Number.isNaN(at.getTime()) && at.toISOString() === raw;
  }, 'not an instant in canonical ISO form');

/** `messages.seq` is an `integer`, so this is where the column stops. */
const SEQ_MAX = 2_147_483_647;

/** Refuses a sign, a leading zero, a decimal point, and anything past the column. */
const sequenceNumber = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .refine((value) => value <= SEQ_MAX);

const conversationParts = z.tuple([canonicalInstant, z.string()]);
const messageParts = z.tuple([sequenceNumber]);

/** One sentence for every way a cursor can be wrong: none of them is the caller's business. */
const malformed = (raw: string): ValidationError =>
  new ValidationError('Malformed cursor.', { length: raw.length });

export const conversationCursor: CursorCodec<ConversationCursor> = {
  encode: (position) => encode([position.updatedAt.toISOString(), position.id]),
  decode: (raw) => {
    const parsed = conversationParts.safeParse(partsOf(raw));
    if (!parsed.success) return Err(malformed(raw));

    // Through the branded constructor rather than a second UUID pattern: one
    // definition of what a ConversationId is, and it is the one that mints the
    // brand after checking the format.
    const [updatedAt, id] = parsed.data;
    const owned = ConversationId.parse(id);

    return owned.ok ? Ok({ updatedAt: new Date(updatedAt), id: owned.value }) : Err(malformed(raw));
  },
};

export const messageCursor: CursorCodec<MessageCursor> = {
  encode: (position) => encode([String(position.seq)]),
  decode: (raw) => {
    const parsed = messageParts.safeParse(partsOf(raw));

    return parsed.success ? Ok({ seq: parsed.data[0] }) : Err(malformed(raw));
  },
};

/**
 * Turns the `limit + 1` rows a query asked for into a page of `limit`. The extra
 * row is the entire mechanism: `nextCursor` is set because a further row was
 * seen, not because `items.length === limit` — which is wrong exactly when the
 * total divides evenly, and offers a "load more" that comes back empty.
 */
export function pageOf<TItem, TCursor>(
  rows: readonly TItem[],
  request: PageRequest<TCursor>,
  positionOf: (item: TItem) => TCursor,
): Page<TItem, TCursor> {
  const items = rows.slice(0, request.limit);
  const last = items.at(-1);

  return {
    items,
    nextCursor: rows.length > request.limit && last !== undefined ? positionOf(last) : null,
  };
}
