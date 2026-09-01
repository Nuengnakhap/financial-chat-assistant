import { Module } from '@nestjs/common';

import { LayeredCache } from './layered-cache';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [LayeredCache],
  exports: [LayeredCache],
})
export class CacheModule {}
