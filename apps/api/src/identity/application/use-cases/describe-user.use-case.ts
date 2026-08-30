import type { UserId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/persistence/unit-of-work';
import type { StoredUser } from '../ports/user.repository';

@Injectable()
export class DescribeUserUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /**
   * `null` when the account has gone since the token was issued. The token
   * stays valid until it expires — it is signed, not looked up — so a deleted
   * user is something every caller of this has to be able to answer.
   */
  async execute(userId: UserId): Promise<StoredUser | null> {
    return await this.uow.run(async (ctx) => await ctx.users.findById(userId));
  }
}
