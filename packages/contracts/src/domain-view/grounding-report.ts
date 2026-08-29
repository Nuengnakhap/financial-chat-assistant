import { z } from 'zod';

/**
 * The evidence behind an answer, sent to the client so a figure can be traced
 * back to the row it came from. An assistant message that is `complete` always
 * carries one — that pairing is the no-hallucination guarantee made visible.
 */

export const claim = z.object({
  /** The literal exactly as it appears in the answer, e.g. "$21.4B". */
  text: z.string().min(1),
  /** Integer value in the unit the column uses, so matching never compares floats. */
  value: z.string().regex(/^-?\d+$/),
  toolCallId: z.string().min(1),
  rowIndex: z.number().int().min(0),
  column: z.string().min(1),
});

export const violation = z.object({
  text: z.string().min(1),
  reason: z.enum(['no_evidence', 'value_mismatch', 'unit_mismatch', 'out_of_coverage']),
});

export const groundingReport = z.object({
  verdict: z.enum(['pass', 'fail']),
  checkedClaims: z.array(claim),
  violations: z.array(violation),
});

export type Claim = z.infer<typeof claim>;
export type Violation = z.infer<typeof violation>;
export type GroundingReport = z.infer<typeof groundingReport>;
