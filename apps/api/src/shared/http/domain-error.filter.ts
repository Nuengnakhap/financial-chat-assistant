import { isDomainError, type DomainError } from '@fca/domain';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  codeForHttpStatus,
  messageForCode,
  statusForDomainCode,
  type ApiFailure,
} from './api-response';
import { currentRequestId } from './request-context';
import { AppLogger } from '../observability/app-logger';

interface Answer {
  readonly status: number;
  readonly body: ApiFailure;
}

/**
 * The single place an exception becomes a response. Two rules it exists to keep:
 * a failure answers with the status its code implies, and nothing a caller
 * receives describes how the server is built — no developer message, no stack,
 * no exception name, and no wording written by the framework either.
 *
 * This assumes the response has not started. Once an endpoint streams, a failure
 * mid-response cannot be answered with a status — the stream carries its own
 * terminal `error` event instead, and the SSE controller handles it before the
 * exception reaches here.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const requestId = currentRequestId();
    const { status, body } = this.toAnswer(exception, requestId);

    host.switchToHttp().getResponse<FastifyReply>().status(status).send(body);
  }

  private toAnswer(exception: unknown, requestId: string): Answer {
    if (isDomainError(exception)) return this.fromDomainError(exception, requestId);
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // The framework's message is dropped, not forwarded: it is written for
      // whoever wrote the framework, and a 500 may quote an internal detail.
      this.logger.warn(exception.message, { requestId });
      return answer(status, codeForHttpStatus(status), requestId);
    }

    // Anything else is a bug: keep the detail, give the caller none of it.
    this.logger.error('unhandled exception', {
      requestId,
      err: exception instanceof Error ? exception : new Error(String(exception)),
    });
    return answer(500, 'internal', requestId);
  }

  private fromDomainError(error: DomainError, requestId: string): Answer {
    this.logger.warn(error.message, { requestId });
    return answer(statusForDomainCode(error.code), error.code, requestId);
  }
}

function answer(status: number, code: ApiFailure['code'], requestId: string): Answer {
  return { status, body: { code, message: messageForCode(code), requestId } };
}
