import { Module } from '@nestjs/common';

import { DatabaseService } from './database.service';
import { DrizzleUnitOfWork } from './drizzle-unit-of-work';
import { UNIT_OF_WORK } from './unit-of-work';

@Module({
  providers: [DatabaseService, { provide: UNIT_OF_WORK, useClass: DrizzleUnitOfWork }],
  exports: [DatabaseService, UNIT_OF_WORK],
})
export class PersistenceModule {}
