import type { UserId } from '@fca/domain';
import { eq, sql } from 'drizzle-orm';

import type { DbOrTx } from '../../shared/persistence/db-or-tx';
import { users } from '../../shared/persistence/schema';
import type {
  Credentials,
  NewUser,
  StoredUser,
  UserRepository,
} from '../application/ports/user.repository';

const VIEW = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  createdAt: users.createdAt,
};

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: DbOrTx) {}

  /**
   * `ON CONFLICT DO NOTHING` rather than catching the violation: a failed INSERT
   * poisons the surrounding transaction, so the caller could not go on to open a
   * session in the same unit of work. An empty result is the taken address.
   */
  async create(user: NewUser): Promise<StoredUser | null> {
    const [row] = await this.db
      .insert(users)
      .values({
        email: user.email,
        displayName: user.displayName,
        passwordHash: user.passwordHash,
      })
      .onConflictDoNothing()
      .returning(VIEW);

    return row === undefined ? null : toStored(row);
  }

  async findCredentialsByEmail(email: string): Promise<Credentials | null> {
    // Matched the way `uq_users_email` is built, so the lookup uses the index
    // and two people cannot register the same address in different cases.
    const [row] = await this.db
      .select({ ...VIEW, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
      .limit(1);

    if (row === undefined) return null;

    const { passwordHash, ...view } = row;
    return { user: toStored(view), passwordHash };
  }
}

function toStored(row: {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
}): StoredUser {
  // The only place a raw column becomes a branded id; the row is our own.
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  return { ...row, id: row.id as UserId };
}
