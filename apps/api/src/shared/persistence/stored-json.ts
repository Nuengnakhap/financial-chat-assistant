import {
  groundingReport,
  messagePart,
  type GroundingReport,
  type MessagePart,
} from '@fca/contracts';
import { z } from 'zod';

/**
 * The one door a `jsonb` column comes back through.
 *
 * `messages.parts` and `messages.verification` have no shape the database can
 * hold: `jsonb` says it is JSON and nothing more. So the shape is checked on
 * the way out, every time, and a row that does not parse fails the whole read
 * rather than being drawn as half a message.
 *
 * The migration functions are the reason this is a module rather than four
 * copies of `z.array(messagePart).parse(...)`. They are the identity today —
 * proven by a test, so that stays true by accident rather than by hope — and
 * they are where the code that reads an older shape goes on the day there is
 * one. Four call sites would be four places to remember, which is none.
 *
 * ## Why there is no `{"v":1,...}` envelope
 *
 * The obvious version marker cannot go on `parts`. The M6 constraint —
 * `chk_user_message_length` — asserts `jsonb_typeof(parts) = 'array'` for every
 * user message, because that column is where a prompt-injection payload would
 * arrive and its size is capped there. Wrapping the array in an object makes
 * `jsonb_typeof` return `object`, and every user message is rejected: measured
 * against the real database, not reasoned about.
 *
 * Which leaves a choice between migrating a live column to gain a byte, and
 * versioning by shape. Shape wins, because `messagePart` is a discriminated
 * union already: `kind` says what each part is, an unrecognised one fails the
 * parse loudly, and the seam below is where an old shape becomes a new one.
 * The envelope would buy the ability to say "this blob was written under the
 * rules of vintage N" — worth having one day, and not worth a migration and a
 * weakened constraint today.
 */

const parts = z.array(messagePart);
const verification = groundingReport.nullable();

/**
 * Identity, and deliberately still called. The day `parts` changes shape, this
 * is the function that reads the old one — and every reader already goes
 * through it, so nothing has to be found and edited under time pressure.
 */
export function migratePartsToLatest(stored: unknown): unknown {
  return stored;
}

/** The same seam for the other `jsonb` column, for the same reason. */
export function migrateVerificationToLatest(stored: unknown): unknown {
  return stored;
}

/**
 * Throws on anything this build cannot render. That is the right answer for a
 * message on its way to a person: an error card says something is wrong, and
 * half an answer says nothing is.
 */
export function readParts(stored: unknown): MessagePart[] {
  return parts.parse(migratePartsToLatest(stored));
}

/**
 * Nothing, for a row being read as history rather than shown. A turn from
 * forty messages ago that this build cannot read is worth leaving out of the
 * transcript; it is not worth refusing to answer the question in front of you.
 */
export function readPartsOrNothing(stored: unknown): readonly MessagePart[] {
  const said = parts.safeParse(migratePartsToLatest(stored));

  return said.success ? said.data : [];
}

export function readVerification(stored: unknown): GroundingReport | null {
  return verification.parse(migrateVerificationToLatest(stored ?? null));
}
