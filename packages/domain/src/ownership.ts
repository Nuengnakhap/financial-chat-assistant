import type { UserId } from './identifiers';

/**
 * Ownership is a parameter, not something a caller has to remember. Every
 * repository of an owned resource takes one and every query filters on it, so
 * "read someone else's rows" is not a call that can be written.
 *
 * It lives here rather than in one context's ports because every context that
 * holds user data needs the same word for it, and a copy per context is how two
 * of them end up meaning slightly different things.
 */
export interface OwnerScope {
  readonly userId: UserId;
}
