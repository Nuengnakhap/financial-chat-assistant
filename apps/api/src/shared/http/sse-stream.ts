import { Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { SseWriter } from './sse-writer';
import { AppLogger } from '../observability/app-logger';

/**
 * An event stream as a response: the headers, the keep-alive, the backpressure,
 * and the list of connections this process currently has open.
 *
 * Knowing nothing about generations is deliberate — it takes frames, not events —
 * so the one thing every long-lived response needs is written once rather than
 * per feature.
 */

/** Well under the timeout of any proxy that closes idle connections, and invisible to a reader. */
const KEEP_ALIVE_MS = 15_000;

export interface Frame {
  /** What a client would resume from. Null for anything the server made up. */
  readonly id: string | null;
  readonly data: unknown;
}

@Injectable()
export class SseStream {
  private readonly open = new Set<SseWriter>();

  constructor(private readonly logger: AppLogger) {}

  /**
   * Returns when the events run out, the reader goes away, or the reader falls
   * so far behind that keeping up with it would cost this process memory it
   * cannot bound. All three end the same way, because the client can resume from
   * where it got to and none of them touches the work being streamed.
   */
  async pipe(reply: FastifyReply, frames: AsyncIterable<Frame>): Promise<void> {
    const writer = new SseWriter(reply.raw);
    this.open.add(writer);
    writer.open();

    const beat = setInterval(() => {
      writer.keepAlive();
    }, KEEP_ALIVE_MS);
    // A keep-alive is not a reason to hold the process open at shutdown.
    beat.unref();

    try {
      await this.write(writer, frames);
    } finally {
      clearInterval(beat);
      this.open.delete(writer);
      writer.end();
    }
  }

  /**
   * Every open stream told to come back, before the server stops accepting
   * connections. Without it a rolling restart cuts each reader mid-answer and
   * they reconnect on a timeout instead of immediately — the generation itself is
   * untouched either way, and that is what makes this only a matter of how long
   * the screen sits still.
   */
  async windDown(): Promise<void> {
    const closing = [...this.open].map(async (writer) => {
      await writer.write(null, { type: 'reconnect_hint' });
      writer.end();
    });
    this.open.clear();

    await Promise.allSettled(closing);
  }

  private async write(writer: SseWriter, frames: AsyncIterable<Frame>): Promise<void> {
    for await (const frame of frames) {
      if (await writer.write(frame.id, frame.data)) continue;

      this.logger.warn('cut a reader that could not keep up with its stream', {
        scope: 'SseStream',
      });
      return;
    }
  }
}
