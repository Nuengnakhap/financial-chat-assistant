import { describe, expect, it } from 'vitest';

import { sqlBeingWritten } from '../writing-sql';

/**
 * What a person sees while the model is still typing its query.
 *
 * The model streams a tool call's arguments as JSON, a few characters at a
 * time, so what the browser holds mid-call is a JSON document that has not been
 * closed yet: `{"sql":"SELECT ROW_NUMBER`. Before this existed, that string was
 * put on screen verbatim — braces, key, escaped quotes and all — under a card
 * that says "Writing a query". The card was showing the envelope rather than
 * the letter.
 *
 * Parsing is not an option: the document is incomplete by definition. What is
 * possible is reading the value of the one key we know is being written, and
 * stopping wherever it currently stops.
 */
describe('the query as it is being typed', () => {
  it('shows nothing before the key has arrived', () => {
    expect(sqlBeingWritten('')).toBe('');
    expect(sqlBeingWritten('{')).toBe('');
    expect(sqlBeingWritten('{"sq')).toBe('');
    expect(sqlBeingWritten('{"sql"')).toBe('');
    expect(sqlBeingWritten('{"sql":')).toBe('');
  });

  it('shows the statement from the first character of it', () => {
    expect(sqlBeingWritten('{"sql":"')).toBe('');
    expect(sqlBeingWritten('{"sql":"SELECT ')).toBe('SELECT ');
    expect(sqlBeingWritten('{"sql":"SELECT revenue FROM financial_data')).toBe(
      'SELECT revenue FROM financial_data',
    );
  });

  it('shows a finished statement without the JSON around it', () => {
    expect(sqlBeingWritten('{"sql":"SELECT 1"}')).toBe('SELECT 1');
  });

  it('reads the escapes JSON puts in, because SQL is full of quotes', () => {
    expect(sqlBeingWritten('{"sql":"SELECT \\"x\\" FROM t')).toBe('SELECT "x" FROM t');
    expect(sqlBeingWritten('{"sql":"SELECT 1\\nFROM t')).toBe('SELECT 1\nFROM t');
    expect(sqlBeingWritten('{"sql":"a\\\\b')).toBe('a\\b');
    expect(sqlBeingWritten('{"sql":"\\u0041')).toBe('A');
  });

  it('holds back half an escape rather than showing a backslash', () => {
    // The stream can stop between the backslash and what it escapes.
    expect(sqlBeingWritten('{"sql":"SELECT 1\\')).toBe('SELECT 1');
    expect(sqlBeingWritten('{"sql":"SELECT \\u00')).toBe('SELECT ');
  });

  it('drops an escape that is not one rather than drawing a null character', () => {
    // `parseInt('ZZZZ', 16)` is NaN and `String.fromCharCode(NaN)` is U+0000.
    expect(sqlBeingWritten('{"sql":"SELECT \\uZZZZ')).toBe('SELECT ');
    expect(sqlBeingWritten('{"sql":"SELECT \\u12G4')).toBe('SELECT ');
  });

  it('shows nothing for a tool whose arguments have no query in them', () => {
    // `describe_coverage` takes `{}` — the card must stay away rather than
    // announce a query that is not being written.
    expect(sqlBeingWritten('{}')).toBe('');
    expect(sqlBeingWritten('{"company":"Apple"')).toBe('');
  });
});
