import { describe, expect, it } from 'vitest';

import { titleFromMessage } from '../title';

describe('naming a conversation after its first message', () => {
  it('uses a short message as it stands', () => {
    expect(titleFromMessage('What was Apple revenue in 2024?')).toBe(
      'What was Apple revenue in 2024?',
    );
  });

  it('reads as one line however the message was typed', () => {
    expect(titleFromMessage('  Revenue\n  by\tyear  ')).toBe('Revenue by year');
  });

  it('breaks at a word rather than mid-syllable', () => {
    const title = titleFromMessage(
      'Compare the revenue and net income of Apple and Microsoft across every year',
    );

    expect(title).toBe('Compare the revenue and net income of Apple and Microsoft…');
    expect(title?.endsWith('…')).toBe(true);
  });

  it('cuts mid-word rather than keeping almost nothing', () => {
    // "on " then one very long word: breaking at the last space would title the
    // conversation "on…", which says less than the wrong-looking alternative.
    const title = titleFromMessage(`on ${'x'.repeat(100)}`);

    expect(title).toBe(`on ${'x'.repeat(57)}…`);
  });

  it('stays inside what the column accepts, even for the longest message allowed', () => {
    // 4,000 characters is the ceiling `startGenerationBody` puts on a message;
    // the title column stops at 120.
    const title = titleFromMessage('word '.repeat(800));

    expect(title?.length).toBeLessThanOrEqual(120);
  });

  it('has no name for a message that is only whitespace', () => {
    // The caller keeps the name the conversation already has: a blank title is
    // one `chk_conversation_title_length` would refuse anyway.
    expect(titleFromMessage('   \n\t ')).toBeNull();
    expect(titleFromMessage('')).toBeNull();
  });

  it('never splits a character that is made of several', () => {
    // A family emoji is one character to a reader and seven code points to the
    // machine. Cutting between them leaves a dangling joiner, and cutting a
    // surrogate pair leaves half a character that becomes U+FFFD when encoded.
    const title =
      titleFromMessage(`abc${'\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'.repeat(20)}`) ?? '';

    expect(title.endsWith('\u200D…')).toBe(false);
    expect(/[\uD800-\uDFFF]/u.test(title)).toBe(false);
  });

  it('never leaves half a character behind', () => {
    // An emoji is two UTF-16 units, so cutting by `length` lands between its
    // halves and the leftover becomes U+FFFD the moment it is encoded — a
    // conversation named `abc…\uFFFD…` for as long as it exists. The prefix is
    // three characters so the cut falls on an odd offset, which is where it
    // happens.
    const title = titleFromMessage(`abc${'\u{1F600}'.repeat(40)}`) ?? '';

    // With the `u` flag this class matches a code point, and a surrogate is
    // only ever its own code point when it has been separated from its pair.
    expect(/[\uD800-\uDFFF]/u.test(title)).toBe(false);
  });

  it('measures a message the way the column does', () => {
    // Forty emoji are forty characters and eighty UTF-16 units. Counting units
    // would truncate a title that fits, and the check constraint counts
    // characters, so both sides now mean the same thing.
    const emoji = '\u{1F600}'.repeat(40);

    expect(titleFromMessage(emoji)).toBe(emoji);
  });

  it('stays inside the column for a message that is all emoji', () => {
    const title = titleFromMessage('\u{1F600}'.repeat(200)) ?? '';

    // Counted the way `char_length` counts on the column it has to fit.
    expect(Array.from(title).length).toBeLessThanOrEqual(120);
  });

  it('keeps a message that is exactly as long as the limit whole', () => {
    const exact = 'a'.repeat(60);

    expect(titleFromMessage(exact)).toBe(exact);
  });
});
