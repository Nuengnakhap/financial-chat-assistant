import { isTerminalStreamEvent, parseStreamEvent, type StreamEvent } from '@fca/contracts';
import type { MessageId } from '@fca/domain';
import { Injectable } from '@nestjs/common';

import { K, type RedisKey } from '../../shared/redis/keys';
import { RedisService } from '../../shared/redis/redis.service';
import { StreamMultiplexer, type StreamSubscription } from '../../shared/redis/stream-multiplexer';
import { isAfter, type StreamRetention } from '../../shared/redis/stream-reader';
import {
  STREAM_START,
  type GenerationEvents,
  type StoredStreamEvent,
} from '../application/ports/generation-events.port';

/**
 * Where a generation's events live between being produced and being read.
 *
 * The runner writes here and never to a socket, which is what makes a generation
 * survive the connection that asked for it: closing a tab, losing a signal or
 * moving to another device changes who is reading, not whether the work
 * continues. A reader asks for everything after the last id it saw, so attaching
 * for the first time and resuming after an hour on a train are the same call.
 */

/**
 * Half an hour after the last event, which is far longer than any answer takes
 * and far shorter than the message row lives. A client arriving after that reads
 * the finished message from the database instead — the stream is a way of
 * watching something happen, not the record of it.
 */
const RETENTION: StreamRetention = { maxLength: 4_096, ttlSeconds: 1_800 };

const REPLAY_BATCH = 512;

/** Not stored anywhere: the reader fell behind, and reattaching is the fix. */
const LAGGING: StoredStreamEvent = { id: null, event: { type: 'reconnect_hint' } };

interface Progress {
  readonly last: string;
  /** True when the replay reached the end of the generation, so there is no live part. */
  readonly finished: boolean;
}

@Injectable()
export class GenerationStream implements GenerationEvents {
  constructor(
    private readonly redis: RedisService,
    private readonly streams: StreamMultiplexer,
  ) {}

  async append(messageId: MessageId, event: StreamEvent): Promise<void> {
    await this.redis.appendToStream(K.streamBuffer(messageId), JSON.stringify(event), RETENTION);
  }

  async replay(messageId: MessageId): Promise<readonly StoredStreamEvent[]> {
    const stored: StoredStreamEvent[] = [];
    for await (const event of this.replayAfter(K.streamBuffer(messageId), STREAM_START)) {
      stored.push(event);
    }

    return stored;
  }

  /**
   * Read out of the id of the last entry, which is the millisecond Redis wrote
   * it. The stream is the heartbeat: a runner that is alive is producing, and
   * one that has stopped producing has stopped, whatever its process thinks.
   */
  async lastActivityAt(messageId: MessageId): Promise<Date | null> {
    const id = await this.redis.endOfStream(K.streamBuffer(messageId));
    if (id === STREAM_START) return null;

    const [milliseconds] = id.split('-');

    return new Date(Number(milliseconds));
  }

  /**
   * Everything after `afterId`, then everything that happens next, ending at the
   * generation's terminal event or when the caller lets go.
   */
  async *read(
    messageId: MessageId,
    afterId: string,
    signal: AbortSignal,
  ): AsyncGenerator<StoredStreamEvent> {
    const key = K.streamBuffer(messageId);
    // Attached before a single entry is replayed. The other order leaves a
    // window where an event reaches neither path, and one delta missing from
    // the middle of an answer reads as a finished sentence with a word gone.
    const subscription = await this.streams.subscribe(key);

    try {
      const caughtUp = yield* this.replayAfter(key, afterId);
      if (caughtUp.finished) return;

      yield* live(subscription, caughtUp.last, signal);
    } finally {
      subscription.close();
    }
  }

  private async *replayAfter(
    key: RedisKey,
    afterId: string,
  ): AsyncGenerator<StoredStreamEvent, Progress> {
    let last = afterId;

    /* eslint-disable no-await-in-loop -- each batch says where the next one
       starts, so there is nothing to ask for until this one has come back. */
    for (;;) {
      const batch = await this.redis.readStreamAfter(key, last, REPLAY_BATCH);
      if (batch.length === 0) return { last, finished: false };

      for (const entry of batch) {
        last = entry.id;
        const event = decode(entry.payload);
        if (event === null) continue;

        yield { id: entry.id, event };
        if (isTerminalStreamEvent(event)) return { last, finished: true };
      }
    }
    /* eslint-enable no-await-in-loop */
  }
}

/**
 * The live tail. Entries at or before what the replay already yielded are
 * dropped rather than trusted to be new: the two paths overlap by design, and
 * the id is what says which of them a client has already seen.
 */
async function* live(
  subscription: StreamSubscription,
  afterId: string,
  signal: AbortSignal,
): AsyncGenerator<StoredStreamEvent> {
  let last = afterId;

  for await (const entry of subscription.entries.drain(signal)) {
    if (!isAfter(entry.id, last)) continue;
    last = entry.id;

    const event = decode(entry.payload);
    if (event === null) continue;

    yield { id: entry.id, event };
    if (isTerminalStreamEvent(event)) return;
  }

  if (subscription.entries.overflow) yield LAGGING;
}

/**
 * Null for anything this build cannot read. A stream outlives a deployment, so
 * an event written by a newer process can be sitting in one when an older one
 * reads it — and skipping it is the rule the client already follows.
 */
function decode(payload: string): StreamEvent | null {
  try {
    return parseStreamEvent(JSON.parse(payload));
  } catch {
    return null;
  }
}
