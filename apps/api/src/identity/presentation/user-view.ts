import type { UserView } from '@fca/contracts';

import type { StoredUser } from '../application/ports/user.repository';

/** The wire form: a branded id becomes a string and a `Date` becomes ISO-8601. */
export function toUserView(user: StoredUser): UserView {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
  };
}
