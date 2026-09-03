/**
 * Which model is answering questions here.
 *
 * Not always the one that was configured. A router accepts `auto` and resolves
 * it per request, so the configured name may be a name no price list has — and
 * pricing an unknown name at the dearest rate, which is the safe thing to do,
 * would hold most of a small limit for every question and refuse the first one.
 *
 * The endpoint says what it resolved to, and something asks it at boot for
 * reasons of its own. This is that answer, borrowed: an estimate for what to
 * hold, never for what to charge. What a generation is charged is the name the
 * provider gave with the answer it actually produced.
 */
export interface ModelInUse {
  /** `null` when nothing has answered yet, which is not the same as unknown. */
  resolved(): string | null;
}

export const MODEL_IN_USE = Symbol('ModelInUse');
