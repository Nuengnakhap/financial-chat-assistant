import { ConversationId } from '@fca/domain';
import { describe, expect, it } from 'vitest';

import { conversationCursor, messageCursor, pageOf, type ConversationCursor } from '../pagination';

const AT = new Date('2026-08-31T04:05:06.789Z');
const ID = ConversationId.trusted('cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21');

const position: ConversationCursor = { updatedAt: AT, id: ID };

const asCursor = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** The extremes of a JavaScript Date, written the way `toISOString` writes them. */
const LATEST = new Date(8.64e15).toISOString();
const EARLIEST = new Date(-8.64e15).toISOString();

describe('a conversation cursor', () => {
  it('comes back as the position it was made from', () => {
    const decoded = conversationCursor.decode(conversationCursor.encode(position));

    expect(decoded.ok && decoded.value.updatedAt.toISOString()).toBe(AT.toISOString());
    expect(decoded.ok && decoded.value.id).toBe(ID);
  });

  it('says nothing a client could read', () => {
    // Opaque is the contract, so nobody builds one by hand and nobody depends
    // on the shape when the keyset changes.
    expect(conversationCursor.encode(position)).not.toContain(ID);
  });

  /**
   * Every one of these decoded without throwing when measured against
   * `Buffer.from(raw, 'base64url')` — including the single altered character,
   * which produced a string still shaped like a cursor. That is why the check
   * is on the value rather than around the decode, and why the list is here in
   * full: each row is a way the silence used to reach the database.
   */
  const tampered: readonly (readonly [string, string])[] = [
    ['truncated', conversationCursor.encode(position).slice(0, 12)],
    ['altered by one character', `Z${conversationCursor.encode(position).slice(1)}`],
    ['not base64 at all', 'not a cursor at all!!'],
    ['base64 of something else', asCursor('hello')],
    ['the right shape with a broken instant', asCursor(`2026-08-32T04:05:06.789Z|${ID}`)],
    ['an instant that is not canonical', asCursor(`2026-8-31T04:05:06.789Z|${ID}`)],
    ['the right shape with a broken id', asCursor(`${AT.toISOString()}|not-a-uuid`)],
    ['a third part nobody wrote', asCursor(`${AT.toISOString()}|${ID}|admin`)],
    // The two ends of what a Date holds. Both round-trip through `toISOString`
    // and neither fits in a `timestamptz`, so before the shape was pinned they
    // reached the driver: "timestamp out of range" is a 500, not a validation
    // failure, and the caller chose the string.
    ['an instant past the last year the column holds', asCursor(`${LATEST}|${ID}`)],
    ['an instant before the first year the column holds', asCursor(`${EARLIEST}|${ID}`)],
  ];

  it.each(tampered)('refuses one %s', (_name, raw) => {
    const decoded = conversationCursor.decode(raw);

    expect(decoded.ok).toBe(false);
    expect(!decoded.ok && decoded.error.code).toBe('validation');
  });

  it('refuses an empty cursor', () => {
    expect(conversationCursor.decode('').ok).toBe(false);
  });
});

describe('a message cursor', () => {
  it('comes back as the sequence number it was made from', () => {
    const decoded = messageCursor.decode(messageCursor.encode({ seq: 4207 }));

    expect(decoded.ok && decoded.value.seq).toBe(4207);
  });

  it.each([
    ['zero', asCursor('0')],
    ['a leading zero', asCursor('01')],
    ['a negative', asCursor('-1')],
    ['a fraction', asCursor('1.5')],
    ['exponent notation', asCursor('1e3')],
    ['whitespace around a number', asCursor(' 1 ')],
    // One past `integer`. Measured before this bound existed: it decoded, went
    // into the query, and came back `value "2147483648" is out of range for
    // type integer` from the driver.
    ['a sequence one past what the column holds', asCursor('2147483648')],
    ['a sequence of four hundred digits', asCursor('9'.repeat(400))],
    ['a second part', asCursor('1|2')],
  ])('refuses %s', (_name, raw) => {
    expect(messageCursor.decode(raw).ok).toBe(false);
  });

  it('accepts the largest sequence number the column holds', () => {
    // The boundary from the other side, so the bound is exactly int4 rather
    // than somewhere near it.
    const decoded = messageCursor.decode(asCursor('2147483647'));

    expect(decoded.ok && decoded.value.seq).toBe(2_147_483_647);
  });
});

describe('turning rows into a page', () => {
  const request = { limit: 3, cursor: null };
  const seq = (n: number) => ({ seq: n });

  it('offers no next page when the rows ran out early', () => {
    expect(pageOf([seq(1), seq(2)], request, (row) => row).nextCursor).toBeNull();
  });

  it('offers no next page when the total divides evenly', () => {
    // The bug this is here for: deciding from `items.length === limit` is wrong
    // exactly when the last page is full, and offers a "load more" that is
    // empty. Three rows for a limit of three is the last page.
    const page = pageOf([seq(1), seq(2), seq(3)], request, (row) => row);

    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('takes the next position from the last row it kept, not from the extra one', () => {
    const page = pageOf([seq(1), seq(2), seq(3), seq(4)], request, (row) => row);

    expect(page.items.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(page.nextCursor).toEqual({ seq: 3 });
  });

  it('offers no next page for nothing at all', () => {
    expect(pageOf([], request, (row: { seq: number }) => row)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
