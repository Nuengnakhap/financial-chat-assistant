import { GENERATION_PHASES, MESSAGE_STATUSES } from '@fca/domain';
import { describe, expect, it } from 'vitest';

import { messageStatus } from '../message-part';

/**
 * The wire vocabulary and the domain lifecycle are separate definitions on
 * purpose — one is a public contract, the other a business rule — but they must
 * describe the same set of states. Nothing else connects them: a fifth status
 * added to the domain would leave these schemas silently unable to express it,
 * and the mismatch would only surface when a mapper was written.
 *
 * `@fca/domain` is a devDependency: it is used here and nowhere in the shipped
 * package, so the contracts stay importable by a browser client.
 */

describe('message status', () => {
  it.each(MESSAGE_STATUSES)('accepts the domain status %s', (status) => {
    expect(messageStatus.safeParse(status).success).toBe(true);
  });

  it('accepts nothing the domain does not have', () => {
    expect(new Set(messageStatus.options)).toEqual(new Set(MESSAGE_STATUSES));
  });
});

describe('generation phases', () => {
  it('stay internal, and are never named on the wire', () => {
    // A client tracks a message status; a phase is how the server got there.
    // Leaking `repairing` or `settling` would make an internal retry visible as
    // a state the UI has to render.
    for (const phase of GENERATION_PHASES) {
      expect(messageStatus.safeParse(phase).success).toBe(false);
    }
  });
});
