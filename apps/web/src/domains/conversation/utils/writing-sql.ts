/**
 * The statement inside a tool call's arguments, while they are still arriving.
 *
 * The model writes a tool call's arguments as JSON a few characters at a time,
 * so what this page holds mid-call is a document that has not been closed:
 * `{"sql":"SELECT ROW_NUMBER`. `JSON.parse` cannot read that, and putting it on
 * screen unread showed a person the envelope instead of the letter.
 *
 * So this reads one key by hand and stops wherever the stream stopped. It is
 * deliberately narrow: it knows the shape of the one argument this interface
 * draws, and returns nothing for anything else — a tool whose arguments are
 * `{}` has no query to show, and a card announcing one would be a lie.
 */

const OPENING = /"sql"\s*:\s*"/u;

/** Exactly four hex digits, which is what `\u` is followed by or it is nothing. */
const HEX = /^[0-9a-fA-F]{4}$/u;

export function sqlBeingWritten(args: string): string {
  const opening = OPENING.exec(args);
  if (opening === null) return '';

  return unescaped(args.slice(opening.index + opening[0].length));
}

/**
 * JSON's escapes, applied to a string that may end anywhere — including in the
 * middle of an escape. A trailing `\` or half a `\uXXXX` is dropped rather than
 * shown, because a backslash appearing for one frame and then becoming a quote
 * is the flicker this whole function exists to remove.
 */
function unescaped(value: string): string {
  let read = '';
  let at = 0;

  while (at < value.length) {
    const character = value[at] ?? '';
    if (character === '"') return read;
    if (character !== '\\') {
      read += character;
      at += 1;
      continue;
    }

    const escape = readEscape(value, at);
    if (escape === null) return read;
    read += escape.text;
    at += escape.length;
  }

  return read;
}

const SIMPLE: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

interface Escape {
  readonly text: string;
  readonly length: number;
}

function readEscape(value: string, at: number): Escape | null {
  const marker = value[at + 1];
  if (marker === undefined) return null;

  if (marker === 'u') {
    const digits = value.slice(at + 2, at + 6);
    // Four characters, and all four hex: `parseInt('ZZZZ', 16)` is `NaN`, and
    // `String.fromCharCode(NaN)` is U+0000 — a null character drawn on a card
    // that is meant to show a query. Dropping it is what the rest of this does
    // with anything it cannot read yet.
    if (!HEX.test(digits)) return null;

    return { text: String.fromCharCode(Number.parseInt(digits, 16)), length: 6 };
  }

  const simple = SIMPLE[marker];

  return simple === undefined ? null : { text: simple, length: 2 };
}
