import { usageContract, type UsageView } from '@fca/contracts';
import { Controller, Get, UseGuards } from '@nestjs/common';

import { requirePrincipal } from '../../shared/http/request-context';
import { SessionGuard } from '../../shared/http/session.guard';
import { SettleUsageUseCase } from '../application/use-cases/settle-usage.use-case';

/**
 * What is left of somebody's window.
 *
 * The same figures the `usage` event carries at the end of a generation, so a
 * page that has been open all day and one that has just loaded agree. Money
 * crosses as integer micro-USD strings — JSON has only doubles, and a budget
 * that arrives as `0.0014` has already lost the exactness the rest of this path
 * is built to keep.
 */
@Controller()
@UseGuards(SessionGuard)
export class UsageController {
  constructor(private readonly usage: SettleUsageUseCase) {}

  @Get(usageContract.get.path)
  async read(): Promise<UsageView> {
    const { userId } = requirePrincipal();

    return await this.usage.read(userId);
  }
}
