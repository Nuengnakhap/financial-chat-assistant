import type { LoggerService } from '@nestjs/common';

import type { AppLogger } from './app-logger';

/**
 * NestJS calls `log(message, scope)` where `scope` is a bare string. Passing
 * that straight to pino makes the *scope* the message and loses the real one —
 * which is what happened before this existed. Adapting here keeps `AppLogger`
 * strictly typed for our own code.
 */
export class NestLoggerBridge implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.log(render(message), scopeOf(params));
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn(render(message), scopeOf(params));
  }

  error(message: unknown, ...params: unknown[]): void {
    this.logger.error(render(message), scopeOf(params));
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.logger.debug(render(message), scopeOf(params));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.logger.debug(render(message), scopeOf(params));
  }
}

function render(message: unknown): string {
  return typeof message === 'string' ? message : JSON.stringify(message);
}

const SCOPE_MAX_LENGTH = 80;

/**
 * Nest passes the emitting class name as the last string argument, but `error`
 * takes `(message, stack, context)` and may be called without the context — so
 * the last argument is sometimes a stack trace. Taking it would put a multi-line
 * dump in a field documented as "a class name, never a value", so the search
 * skips anything that does not look like one.
 */
function scopeOf(params: readonly unknown[]): { scope?: string } {
  for (let index = params.length - 1; index >= 0; index -= 1) {
    const candidate = params[index];
    if (
      typeof candidate === 'string' &&
      candidate !== '' &&
      !candidate.includes('\n') &&
      candidate.length <= SCOPE_MAX_LENGTH
    ) {
      return { scope: candidate };
    }
  }
  return {};
}
