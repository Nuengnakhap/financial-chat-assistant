import { Injectable } from '@nestjs/common';
import { pino, type Logger } from 'pino';

/**
 * The only fields a log line may carry. Message content and model answers are
 * absent by construction rather than by redaction: attaching one is a compile
 * error, so the rule cannot be forgotten under deadline.
 */
export interface LogContext {
  readonly requestId?: string;
  /** Hashed, never the id itself — logs outlive the reason we kept them. */
  readonly userIdHash?: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly durationMs?: number;
  /** Which component emitted the line — a class name, never a value. */
  readonly scope?: string;
  /** The name a background task registered under, never its input. */
  readonly task?: string;
  readonly err?: Error;
}

/**
 * `err` stays typed as `Error` rather than widening to `unknown`, or a caught
 * value carrying message content could be logged. This is how a caught value
 * gets in: once, here, instead of at every `catch`.
 */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface LoggerOptions {
  readonly level: string;
  readonly pretty: boolean;
  readonly destination?: NodeJS.WritableStream;
}

export function createPinoLogger(options: LoggerOptions): Logger {
  const config = {
    level: options.level,
    // A backstop for anything that reaches pino by another route.
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'password', 'token', 'apiKey'],
      censor: '[redacted]',
    },
    // pino spawns a worker that resolves this by name at runtime, so nothing
    // imports it and static analysis cannot see it — hence the knip ignore, and
    // hence it must be a runtime dependency rather than a dev one.
    ...(options.pretty ? { transport: { target: 'pino-pretty' as const } } : {}),
  };
  return options.destination === undefined ? pino(config) : pino(config, options.destination);
}

/**
 * Deliberately not a NestJS `LoggerService`: that interface takes
 * `(message: any, ...params: any[])`, and accepting it here would reopen the
 * hole `LogContext` closes. `NestLoggerBridge` adapts the framework's calls.
 */
@Injectable()
export class AppLogger {
  constructor(private readonly logger: Logger) {}

  log(message: string, context: LogContext = {}): void {
    this.logger.info(context, message);
  }

  warn(message: string, context: LogContext = {}): void {
    this.logger.warn(context, message);
  }

  error(message: string, context: LogContext = {}): void {
    this.logger.error(context, message);
  }

  debug(message: string, context: LogContext = {}): void {
    this.logger.debug(context, message);
  }

  child(context: LogContext): AppLogger {
    return new AppLogger(this.logger.child(context));
  }
}
