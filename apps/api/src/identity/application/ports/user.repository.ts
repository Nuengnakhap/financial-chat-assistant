import type { UserId } from '@fca/domain';

export interface StoredUser {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: Date;
}

export interface NewUser {
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

/** What signing in needs and nothing else, so a hash cannot leak into a view. */
export interface Credentials {
  readonly user: StoredUser;
  readonly passwordHash: string;
}

export interface UserRepository {
  /** `null` when the address is already taken, decided by the database, not a prior read. */
  create(user: NewUser): Promise<StoredUser | null>;

  /**
   * `null` for an address nobody has registered. The caller must still do the
   * password work anyway, or the absence answers faster than a wrong password
   * and the difference is measurable.
   */
  findCredentialsByEmail(email: string): Promise<Credentials | null>;
}
