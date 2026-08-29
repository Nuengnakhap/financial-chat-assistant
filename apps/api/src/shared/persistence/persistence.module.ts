import { Module } from '@nestjs/common';

import { DatabaseService } from './database.service';
import { DrizzleUnitOfWork } from './drizzle-unit-of-work';
import { UNIT_OF_WORK } from './unit-of-work';
import { HEALTH_INDICATORS } from '../health/health-indicator';

@Module({
  providers: [
    DatabaseService,
    { provide: UNIT_OF_WORK, useClass: DrizzleUnitOfWork },
    // The database is a readiness dependency: without it a request cannot be
    // served at all. Registered by the module that owns it, not by the probe.
    {
      provide: HEALTH_INDICATORS,
      useFactory: (db: DatabaseService) => [db],
      inject: [DatabaseService],
    },
  ],
  exports: [DatabaseService, UNIT_OF_WORK, HEALTH_INDICATORS],
})
export class PersistenceModule {}
