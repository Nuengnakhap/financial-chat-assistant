import { describe, expect, it } from 'vitest';

import { STREAM_FIELD, toEntries, toSlices } from '../redis-connections';
import { isAfter } from '../stream-reader';

/**
 * Reading what a driver hands back. Everything here arrives as `unknown` on
 * purpose: `XREAD` answers with `[key, [[id, [field, value]]]]` nested four
 * deep, and every level of that is a claim by the driver's types about bytes
 * that came from outside this process. Shaped rather than asserted, so a reply
 * that is not what we expect produces nothing rather than an error three frames
 * later.
 */

const row = (id: string, payload: string) => [id, [STREAM_FIELD, payload]];

describe('reading entries out of a reply', () => {
  it('takes the one field an entry is written as', () => {
    expect(toEntries([row('1-0', '{"type":"reconnect_hint"}')])).toEqual([
      { id: '1-0', payload: '{"type":"reconnect_hint"}' },
    ]);
  });

  it('finds it however many other fields came with it', () => {
    expect(toEntries([['1-0', ['other', 'x', STREAM_FIELD, 'kept']]])).toEqual([
      { id: '1-0', payload: 'kept' },
    ]);
  });

  it('skips a row that is not a row', () => {
    expect(toEntries(['not-a-row', null, 7])).toEqual([]);
  });

  it('skips one whose id is not a string, or whose fields are not a list', () => {
    expect(
      toEntries([
        [7, [STREAM_FIELD, 'x']],
        ['1-0', 'fields'],
      ]),
    ).toEqual([]);
  });

  it('skips one with no field of the name it is written under', () => {
    expect(
      toEntries([
        ['1-0', ['something-else', 'x']],
        ['2-0', [STREAM_FIELD, 7]],
      ]),
    ).toEqual([]);
  });
});

describe('reading streams out of a reply', () => {
  it('keeps each key with its entries', () => {
    expect(toSlices([['strm:{a}', [row('1-0', 'x')]]])).toEqual([
      { key: 'strm:{a}', entries: [{ id: '1-0', payload: 'x' }] },
    ]);
  });

  it('answers with nothing at all when the reply is not a list', () => {
    // What `XREAD` returns when a block expires with nothing new.
    expect(toSlices(null)).toEqual([]);
  });

  it('skips a stream whose key is not a string, or whose rows are not a list', () => {
    expect(toSlices([[7, []], ['strm:{a}', 'rows'], 'not-a-stream'])).toEqual([]);
  });
});

describe('deciding which of two ids came first', () => {
  it('compares both halves as numbers', () => {
    // `10-0` sorts before `9-0` as text, so a stream ten milliseconds old would
    // start dropping everything it read.
    expect(isAfter('10-0', '9-0')).toBe(true);
    expect(isAfter('9-0', '10-0')).toBe(false);
  });

  it('falls back to the sequence when the millisecond is the same', () => {
    expect(isAfter('5-2', '5-1')).toBe(true);
    expect(isAfter('5-1', '5-1')).toBe(false);
  });

  it('reads a malformed id as the beginning rather than as nothing at all', () => {
    // `NaN` compares false against everything, so an id that could not be read
    // would quietly drop every entry a reader was handed. Silence in the middle
    // of an answer is the one failure this system must not have.
    expect(isAfter('1-0', 'nonsense')).toBe(true);
    expect(isAfter('nonsense', '1-0')).toBe(false);
  });
});
