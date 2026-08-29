import { cpus } from 'node:os';
import { resolve } from 'node:path';

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Piscina } from 'piscina';

export interface CountTokensTask {
  readonly text: string;
}

export interface CpuPoolOptions {
  readonly workerFile: string;
  readonly maxThreads: number;
  /** Full queue rejects immediately: a task that waits past its deadline is wasted work. */
  readonly maxQueue: number;
  /**
   * How long an idle thread is kept. A busy period loads the vocabulary once;
   * after this much quiet the thread goes and the next call pays for it again,
   * which is the price of not holding threads open for an idle process.
   */
  readonly idleTimeoutMs: number;
}

export const CPU_POOL_OPTIONS = Symbol('CpuPoolOptions');

/** `dist/shared/cpu` and `src/shared/cpu` sit at the same depth, so one path serves both. */
const CPU_WORKER_FILE = resolve(__dirname, '..', '..', '..', 'worker-threads', 'cpu-worker.cjs');

export function defaultCpuPoolOptions(): CpuPoolOptions {
  return {
    workerFile: CPU_WORKER_FILE,
    // One core is left to the event loop, which is the thing being protected.
    maxThreads: Math.max(1, cpus().length - 1),
    maxQueue: 1_000,
    idleTimeoutMs: 60_000,
  };
}

/**
 * Node runs JavaScript on one thread, so a few milliseconds of tokenizing stalls
 * every request already in flight. Work that costs real CPU goes here instead.
 */
@Injectable()
export class CpuPool implements OnModuleDestroy {
  private readonly pool: Piscina<CountTokensTask, unknown>;

  constructor(@Inject(CPU_POOL_OPTIONS) options: CpuPoolOptions) {
    this.pool = new Piscina({
      filename: options.workerFile,
      // No thread until the first task: most of what the API does never needs one.
      minThreads: 0,
      maxThreads: options.maxThreads,
      maxQueue: options.maxQueue,
      idleTimeout: options.idleTimeoutMs,
    });
  }

  async countTokens(text: string, signal?: AbortSignal): Promise<number> {
    const result = await this.pool.run({ text }, { name: 'countTokens', signal: signal ?? null });
    if (typeof result !== 'number' || !Number.isInteger(result)) {
      throw new Error(`cpu worker returned ${typeof result} for countTokens`);
    }
    return result;
  }

  /** Tasks already queued are abandoned; the caller of each one is rejected. */
  async onModuleDestroy(): Promise<void> {
    await this.pool.destroy();
  }
}
