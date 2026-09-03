import type { GroundingReport } from '@fca/contracts';
import { describe, expect, it } from 'vitest';

import {
  migratePartsToLatest,
  migrateVerificationToLatest,
  readParts,
  readPartsOrNothing,
  readVerification,
} from '../stored-json';

/**
 * The seam every `jsonb` column is read through, and the two things it has to
 * be: strict about a shape this build cannot render, and the single place an
 * older shape will one day be turned into a newer one.
 */

const TEXT = { kind: 'text', text: 'Apple earned $383.3B.' };
const CALL = { kind: 'tool_call', id: 'call_1', sql: 'SELECT 1' };

const REPORT: GroundingReport = { verdict: 'pass', checkedClaims: [], violations: [] };

describe('reading the parts of a message', () => {
  it('gives back what was stored, part for part', () => {
    expect(readParts([TEXT, CALL])).toEqual([TEXT, CALL]);
  });

  it('refuses a part nothing can render, rather than dropping it', () => {
    // On the way to a person, half an answer is worse than an error card: one
    // says something is wrong and the other says nothing is.
    expect(() => readParts([TEXT, { kind: 'from_the_future', payload: 1 }])).toThrow();
    expect(() => readParts({ v: 1, parts: [TEXT] })).toThrow();
  });

  it('gives back nothing at all when it is only history', () => {
    // A turn from forty messages ago that this build cannot read is worth
    // leaving out of the transcript. It is not worth refusing to answer the
    // question in front of you.
    expect(readPartsOrNothing([{ kind: 'from_the_future' }])).toEqual([]);
    expect(readPartsOrNothing([TEXT])).toEqual([TEXT]);
  });
});

describe('reading a verification report', () => {
  it('accepts a row that has one and a row that does not', () => {
    expect(readVerification(REPORT)).toEqual(REPORT);
    expect(readVerification(null)).toBeNull();
    expect(readVerification(undefined)).toBeNull();
  });

  it('refuses a report that is not one', () => {
    expect(() => readVerification({ verdict: 'probably fine' })).toThrow();
  });
});

describe('the migration seam', () => {
  it('is the identity today, and says so out loud', () => {
    // Not a placeholder nobody calls: every reader above already goes through
    // it, so the day `parts` changes shape there is one function to edit rather
    // than four call sites to find. This case is what keeps that true — if it
    // ever stops being the identity, the change was deliberate.
    const stored = [TEXT, CALL];

    expect(migratePartsToLatest(stored)).toBe(stored);
    expect(migrateVerificationToLatest(REPORT)).toBe(REPORT);
  });

  it('is what a version envelope would have gone through, and there is not one', () => {
    // `{"v":1,"parts":[…]}` cannot be stored: `chk_user_message_length` asserts
    // `jsonb_typeof(parts) = 'array'` for every user message, which is where the
    // prompt-injection size cap lives. Measured against the real database — the
    // insert is rejected. So the version is the shape, and `kind` carries it.
    expect(() => readParts({ v: 1, parts: [] })).toThrow();
    expect(readParts([])).toEqual([]);
  });
});
