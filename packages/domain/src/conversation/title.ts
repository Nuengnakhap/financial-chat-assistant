/**
 * A conversation is named after the first thing said in it. Sixty characters
 * because the rail it has to fit in is 256px wide and reads two lines there —
 * the table allows 120, which is the outer bound rather than the choice.
 */
const MAX_TITLE = 60;

/**
 * Breaking at the last space is only worth it while it keeps most of the line.
 * Below this a message beginning "on " followed by one very long word would be
 * titled "on…", and cutting mid-word is the better of the two bad answers.
 */
const KEEP_AT_LEAST = 0.5;

/**
 * Cutting is measured in code points and stops at grapheme boundaries, and
 * those are two different reasons.
 *
 * Code points because that is what `char_length` counts on the column, so the
 * limit here and the limit there mean the same thing. A grapheme budget would
 * not: one family emoji is seven code points, and sixty of those would be four
 * hundred and twenty against a column that stops at a hundred and twenty.
 *
 * Grapheme boundaries because a character somebody sees is often more than one
 * code point, and half of one is a lone surrogate — which becomes U+FFFD the
 * moment it is encoded, so the conversation is called `abc…�…` for as long
 * as it exists.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface Cut {
  readonly text: string;
  /** False when something was left behind, which is what earns the ellipsis. */
  readonly whole: boolean;
}

function cutToPoints(flat: string, max: number): Cut {
  let kept = '';
  let points = 0;

  for (const { segment } of GRAPHEMES.segment(flat)) {
    const size = Array.from(segment).length;
    if (points + size > max) return { text: kept, whole: false };

    kept += segment;
    points += size;
  }

  return { text: kept, whole: true };
}

/**
 * `null` when there is nothing worth calling a conversation — a message of only
 * whitespace. The caller keeps whatever name the conversation already has,
 * rather than writing a blank one the table would reject anyway.
 */
export function titleFromMessage(text: string): string | null {
  // Flattened first: a title is one line, and a message that starts with a
  // newline would otherwise be named after an empty one.
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat === '') return null;

  const cut = cutToPoints(flat, MAX_TITLE);
  if (cut.whole) return flat;

  const lastSpace = cut.text.lastIndexOf(' ');
  const kept =
    lastSpace >= cut.text.length * KEEP_AT_LEAST ? cut.text.slice(0, lastSpace) : cut.text;

  return `${kept.trimEnd()}…`;
}
