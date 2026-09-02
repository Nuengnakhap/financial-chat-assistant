import { messagesContract, type Ok as OkBody } from '@fca/contracts';
import { Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { requirePrincipal } from '../../shared/http/request-context';
import { SessionGuard } from '../../shared/http/session.guard';
import { SseStream, type Frame } from '../../shared/http/sse-stream';
import { requireMessageId } from '../application/answer-id';
import { STREAM_START, type StoredStreamEvent } from '../application/ports/generation-events.port';
import { StopGenerationUseCase } from '../application/use-cases/stop-generation.use-case';
import { WatchGenerationUseCase } from '../application/use-cases/watch-generation.use-case';

const ACCEPTED: OkBody = { ok: true };

/**
 * The two things a client does with a generation it did not start in this
 * request: watch it, and ask it to stop.
 *
 * Both are about a message rather than a conversation, and both are answered
 * without the generation being anywhere near this process — it is being written
 * to Redis by whoever picked the job up, which may be another pod and, after a
 * refresh, is usually not the one that took the question.
 */
@Controller()
@UseGuards(SessionGuard)
export class GenerationController {
  constructor(
    private readonly watch: WatchGenerationUseCase,
    private readonly stopping: StopGenerationUseCase,
    private readonly sse: SseStream,
  ) {}

  @Get(messagesContract.stream.path)
  async stream(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { userId } = requirePrincipal();
    const messageId = requireMessageId(id);
    if (!messageId.ok) throw messageId.error;

    // Aborted when the socket goes, which is what releases the reader's place in
    // the multiplexer. Disconnecting is not stopping: the generation carries on.
    const leaving = new AbortController();
    request.raw.on('close', () => {
      leaving.abort();
    });

    const watching = await this.watch.execute({ userId }, messageId.value, {
      afterId: resumeFrom(request),
      signal: leaving.signal,
    });
    // Thrown before a single byte is written, so the filter can still answer
    // with a status. Once the stream is open a failure has to travel as an
    // event, which is what the terminal `error` is for.
    if (!watching.ok) throw watching.error;

    await this.sse.pipe(reply, frames(watching.value));
  }

  @Post(messagesContract.stop.path)
  @HttpCode(messagesContract.stop.status)
  async stop(@Param('id') id: string): Promise<OkBody> {
    const { userId } = requirePrincipal();
    const messageId = requireMessageId(id);
    if (!messageId.ok) throw messageId.error;

    const asked = await this.stopping.execute({ userId }, messageId.value);
    if (!asked.ok) throw asked.error;

    // 202: the generation is somewhere else, and this says the message was sent
    // rather than that the writing has already stopped.
    return ACCEPTED;
  }
}

/**
 * `Last-Event-ID` is the header a browser sends by itself on a reconnect, so
 * resuming costs a client nothing to implement and is impossible to get wrong.
 *
 * It is checked against the shape of a stream id rather than passed on, because
 * it goes into an `XRANGE` bound: anything else — a value a proxy folded two
 * copies of into one, or a value somebody typed — would reach Redis as a
 * malformed range and fail in the middle of a response that has already begun.
 * Anything unreadable means the same as saying nothing: start from the top.
 */
const STREAM_ID = /^\d+-\d+$/;

function resumeFrom(request: FastifyRequest): string {
  const header = request.headers['last-event-id'];

  return typeof header === 'string' && STREAM_ID.test(header) ? header : STREAM_START;
}

async function* frames(events: AsyncIterable<StoredStreamEvent>): AsyncIterable<Frame> {
  for await (const stored of events) yield { id: stored.id, data: stored.event };
}
