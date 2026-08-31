import type { UserView } from '@fca/contracts';
import { UnauthenticatedError } from '@fca/domain';
import { Controller, Get, UseGuards } from '@nestjs/common';

import { toUserView } from './user-view';
import { requirePrincipal } from '../../shared/http/request-context';
import { SessionGuard } from '../../shared/http/session.guard';
import { DescribeUserUseCase } from '../application/use-cases/describe-user.use-case';

@Controller()
export class CurrentUserController {
  constructor(private readonly users: DescribeUserUseCase) {}

  @Get('api/v1/auth/me')
  @UseGuards(SessionGuard)
  async me(): Promise<{ user: UserView }> {
    const principal = requirePrincipal();

    const user = await this.users.execute(principal.userId);
    // The token is signed rather than looked up, so it outlives the account it
    // names. Answering 401 keeps a deleted user from reading as a signed-in one.
    if (user === null) throw new UnauthenticatedError('The signed-in user no longer exists.');

    return { user: toUserView(user) };
  }
}
