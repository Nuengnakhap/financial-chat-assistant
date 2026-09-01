import { Module } from '@nestjs/common';

import { FinancialQueryPool } from './financial-query.pool';

@Module({
  providers: [FinancialQueryPool],
  exports: [FinancialQueryPool],
})
export class FinancialModule {}
