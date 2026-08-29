import { Writable } from 'node:stream';

import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import { AppLogger, createPinoLogger, type LogContext } from '../app-logger';
import { NestLoggerBridge } from '../nest-logger.bridge';

function capturingLogger(): {
  logger: AppLogger;
  raw: Logger;
  lines: () => readonly Record<string, unknown>[];
} {
  const written: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  });

  const raw = createPinoLogger({ level: 'debug', pretty: false, destination });
  return {
    logger: new AppLogger(raw),
    raw,
    lines: () =>
      written
        .join('')
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('what a log line may carry', () => {
  it('records the standard correlation fields', () => {
    const { logger, lines } = capturingLogger();

    logger.log('generation settled', {
      requestId: 'req-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      durationMs: 42,
    });

    expect(lines()[0]).toMatchObject({
      msg: 'generation settled',
      requestId: 'req-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      durationMs: 42,
    });
  });

  it('cannot be handed message content, because the type has no room for it', () => {
    const { logger } = capturingLogger();

    // @ts-expect-error message content and answers are absent by construction,
    // not by redaction. Widening LogContext makes this compile and fails CI.
    const context: LogContext = { requestId: 'req-1', content: 'What was Apple revenue?' };

    expect(() => {
      logger.log('user message appended', context);
    }).not.toThrow();
  });

  it('censors a credential that reaches pino by a route LogContext cannot police', () => {
    const { raw, lines } = capturingLogger();

    // Bound directly on the pino instance, which is what a library or a future
    // http-logger plugin would do. LogContext never sees this.
    raw.child({ password: 'hunter2' }).info('outbound call');
    raw.info({ req: { headers: { cookie: 'session=hunter2' } } }, 'inbound request');

    const written = JSON.stringify(lines());
    expect(written).not.toContain('hunter2');
    expect(written).toContain('[redacted]');
  });

  it('is a backstop, not a filter: an unlisted path is not censored', () => {
    const { raw, lines } = capturingLogger();

    // Says plainly what this mechanism does not do, so nobody relies on it as
    // the reason content stays out of the logs. That reason is LogContext.
    raw.info({ nested: { password: 'hunter2' } }, 'unlisted path');

    expect(JSON.stringify(lines())).toContain('hunter2');
  });

  it('keeps an error with its stack, which is the one detail logs are for', () => {
    const { logger, lines } = capturingLogger();

    logger.error('unhandled exception', { requestId: 'req-1', err: new Error('boom') });

    const line = lines()[0];
    expect(JSON.stringify(line)).toContain('boom');
    expect(line?.['level']).toBe(50);
  });

  it('writes at debug level', () => {
    const { logger, lines } = capturingLogger();

    logger.debug('cache miss', { requestId: 'req-1' });

    expect(lines()[0]?.['level']).toBe(20);
  });

  it('carries a child logger context onto every later line', () => {
    const { logger, lines } = capturingLogger();

    logger.child({ requestId: 'req-9' }).warn('slow query');

    expect(lines()[0]).toMatchObject({ requestId: 'req-9', msg: 'slow query' });
  });
});

describe('the bridge NestJS logs through', () => {
  it('keeps the message as the message and the class name as a field', () => {
    const { logger, lines } = capturingLogger();

    // Nest calls log(message, scope). Forwarding that pair straight to pino
    // made the scope the message and dropped the real one.
    new NestLoggerBridge(logger).log('Nest application successfully started', 'NestApplication');

    expect(lines()[0]).toMatchObject({
      msg: 'Nest application successfully started',
      scope: 'NestApplication',
    });
  });

  it('survives a message that is not a string', () => {
    const { logger, lines } = capturingLogger();

    new NestLoggerBridge(logger).warn({ mapped: 2 }, 'RouterExplorer');

    expect(lines()[0]?.['msg']).toBe('{"mapped":2}');
  });

  it.each(['debug', 'verbose'] as const)('forwards %s, which Nest uses for detail', (method) => {
    const { logger, lines } = capturingLogger();

    new NestLoggerBridge(logger)[method]('mapped route', 'RouterExplorer');

    expect(lines()[0]).toMatchObject({ msg: 'mapped route', scope: 'RouterExplorer' });
  });

  it('omits the scope when the framework does not name one', () => {
    const { logger, lines } = capturingLogger();

    new NestLoggerBridge(logger).error('boom');

    expect(lines()[0]).not.toHaveProperty('scope');
  });
});

describe('the transport the local run actually uses', () => {
  it('constructs with pretty printing, which needs a module that must be installed', () => {
    // app.module.ts asks for pretty:true whenever NODE_ENV is development, which
    // is the default. Without pino-pretty in dependencies this throws and the
    // process never listens — and every other test here passes pretty:false.
    expect(() => createPinoLogger({ level: 'info', pretty: true })).not.toThrow();
  });
});

describe('the scope field never becomes a dumping ground', () => {
  it('keeps a stack trace out of it when Nest omits the context', () => {
    const { logger, lines } = capturingLogger();
    const stack = [
      'Error: boom',
      '    at handler (/app/x.js:1:1)',
      '    at run (/app/y.js:2:2)',
    ].join('\n');

    // Logger.error(message, stack) is a shape Nest's signature allows.
    new NestLoggerBridge(logger).error('request failed', stack);

    expect(lines()[0]).not.toHaveProperty('scope');
  });

  it('still finds the class name when Nest sends both', () => {
    const { logger, lines } = capturingLogger();

    new NestLoggerBridge(logger).error(
      'request failed',
      ['Error: boom', '    at x'].join('\n'),
      'ExceptionsHandler',
    );

    expect(lines()[0]).toMatchObject({ scope: 'ExceptionsHandler' });
  });
});
