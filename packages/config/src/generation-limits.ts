/**
 * The ceilings of one generation, in one place because two parts of the system
 * have to agree on them and neither may import the other.
 *
 * The loop uses them to stop; the budget uses them to work out the most a
 * single answer could possibly cost, and therefore what to hold before letting
 * one start. Written as constants rather than as environment variables on
 * purpose: a limit somebody can raise at deploy time is a limit the reservation
 * arithmetic silently stops covering.
 */
export const GENERATION_LIMITS = {
  /**
   * Queries per draft. Measured against the configured endpoint: two rounds
   * answer an ordinary question, four answer a comparison across years, and
   * anything still asking after five is looping rather than working.
   */
  maxToolRounds: 5,
  /**
   * The largest transcript a single round can send: the system prompt (1,737
   * tokens measured), twenty turns of history, and tool results capped at fifty
   * rows. Rounded up, because it is a bound and not an estimate — under-stating
   * it would under-reserve every generation.
   */
  inputCeilingTokens: 8_000,
} as const;
