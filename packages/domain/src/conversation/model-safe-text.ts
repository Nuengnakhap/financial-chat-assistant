/**
 * What a person typed, with the characters nobody can see taken out.
 *
 * A question travels a long way: it is stored, shown back on a screen, and read
 * by a model that will be asked to follow instructions. Invisible characters do
 * different damage at each stop — they break a rendering, reverse the order
 * words appear in, or end a line in the middle of a JSON string — and at none
 * of those stops do they carry meaning a reader would miss.
 *
 * **That is the whole rule, and its limit.** Removing a character nobody can
 * see cannot change what a question says, so this is safe to do silently. Every
 * *visible* character is left exactly as it was, including the ones that look
 * like an attack: `<|im_start|>` stays `<|im_start|>`, because mangling text a
 * person can read would make what they see and what was stored two different
 * things — and because it is not what stops that attack anyway.
 *
 * What stops it is structural. User content is only ever the value of a
 * `content` field in a JSON request body; nothing in this system builds a
 * prompt by concatenating strings, so there is no template for a sentinel to
 * close. And what stops the attack that matters — a figure with nothing behind
 * it — is the claim gate, which does not care whether the model was fooled.
 */

/** `\n` and `\t` survive: a question may be two paragraphs, and nothing else. */
const KEPT = new Set(['\n', '\t']);

/**
 * Every range taken out, and why.
 *
 * The bidirectional controls are the one entry here that is an attack rather
 * than an accident: they make a string render in an order other than the one it
 * is stored in, so what a person approves and what a machine reads can be made
 * to differ. Everything else arrives from a bad paste or a mis-decoded file.
 *
 * There are more of them than the famous ones. `U+061C` does what `U+200F`
 * does and is easy to leave out because it sits alone in the Arabic block
 * rather than beside the other marks — which is exactly why it is worth
 * naming here rather than trusting a range to have caught it.
 *
 * The zero-width joiner, `U+200D`, is deliberately **absent** from this list: it
 * is what holds an emoji sequence together, and a family emoji falling apart is
 * a visible change to something a person typed on purpose.
 */
const STRIPPED: readonly (readonly [number, number])[] = [
  [0x00, 0x1f], // C0 controls — except the two kept above
  [0x061c, 0x061c], // arabic letter mark: a right-to-left mark under another name
  [0x7f, 0x9f], // delete, and the C1 controls a mis-decoded paste brings
  [0x200b, 0x200b], // zero-width space
  [0x200e, 0x200f], // left-to-right and right-to-left marks
  [0x2028, 0x2029], // line and paragraph separators — line terminators to a JS parser
  [0x202a, 0x202e], // bidirectional embedding and override
  [0x2060, 0x2060], // word joiner
  [0x2066, 0x2069], // bidirectional isolates
  [0xfeff, 0xfeff], // a byte-order mark that got into the middle of a string
];

function isInvisible(character: string): boolean {
  if (KEPT.has(character)) return false;

  const code = character.codePointAt(0) ?? 0;

  return STRIPPED.some(([from, to]) => code >= from && code <= to);
}

export function asModelSafeText(raw: string): string {
  // By code point rather than by UTF-16 unit, so a surrogate pair is never cut
  // in half — every character stripped below is in the basic plane, and an
  // emoji that survives must survive whole.
  return Array.from(raw)
    .filter((character) => !isInvisible(character))
    .join('');
}
