import { Module } from '@nestjs/common';

import { CPU_POOL_OPTIONS, CpuPool, defaultCpuPoolOptions } from './cpu-pool';

@Module({
  providers: [{ provide: CPU_POOL_OPTIONS, useFactory: defaultCpuPoolOptions }, CpuPool],
  exports: [CpuPool],
})
export class CpuModule {}
