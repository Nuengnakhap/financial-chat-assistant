import { Injectable, type OnModuleDestroy } from '@nestjs/common';

import type { RedisKey } from './keys';
import { RedisService } from './redis.service';
import type { StreamEntry, StreamReader, StreamSlice } from './stream-reader';
import { TaskRegistry } from '../../bootstrap/task-registry';
import { AsyncQueue } from '../async/async-queue';
import { delay } from '../async/timeouts';
import { AppLogger, asError } from '../observability/app-logger';

/**
 * One live tail of many Redis streams, shared by every connection on this pod.
 *
 * The obvious implementation gives each connection its own `XREAD BLOCK`, and a
 * blocking read holds a socket for as long as it blocks — so ten thousand people
 * watching an answer would be ten thousand Redis connections from one process,
 * which is not a number Redis or the process will accept. Here the count is a
 * property of the pod (at most `MAX_READERS`) rather than of how many people are
 * watching: each reader blocks on up to `STREAMS_PER_READER` streams in a single
 * command and hands what arrives to whoever asked for that stream.
 *
 * Catching up is not this class's job. A subscriber replays what it missed with
 * `XRANGE`, which blocks nothing and costs no connection, and the two paths meet
 * because a stream new to this pod is tracked from wherever it had already got
 * to — so nothing can fall between them.
 */

const MAX_READERS = 8;
const STREAMS_PER_READER = 64;
/** Short enough that a reader notices a cancelled shutdown quickly, long enough to idle cheaply. */
const BLOCK_MS = 1_000;
const BATCH = 256;
/**
 * About a minute of a fast generation. Past it the subscriber is cut rather than
 * buffered: it can resume by id, and holding more would be this process paying
 * memory for a reader that has stopped reading.
 */
const QUEUE_CAPACITY = 1_024;
const AFTER_FAILURE_MS = 200;

export interface StreamSubscription {
  /** Live entries only; what came before is the caller's to replay. */
  readonly entries: AsyncQueue<StreamEntry>;
  close(): void;
}

@Injectable()
export class StreamMultiplexer implements OnModuleDestroy {
  private readonly readers: Reader[] = [];

  constructor(
    private readonly redis: RedisService,
    private readonly tasks: TaskRegistry,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Attach before replaying, always. A subscriber that replays first and then
   * attaches has a window between the two where an event reaches neither — and a
   * stream missing one delta in the middle reads as a finished answer with a
   * word cut out of it.
   */
  async subscribe(key: RedisKey): Promise<StreamSubscription> {
    const reader = this.readerFor(key);
    const queue = new AsyncQueue<StreamEntry>(QUEUE_CAPACITY);
    // The listener goes on before the stream is tracked, never after: a tracked
    // stream with nobody listening is one the reader drops, and this is the only
    // moment where one could exist.
    reader.add(key, queue);

    if (!reader.has(key)) {
      // Where the stream is now, so the live tail carries what happens next and
      // the caller's own replay carries everything before it.
      reader.track(key, await this.redis.endOfStream(key));
    }
    this.start(reader);

    return {
      entries: queue,
      close: () => {
        reader.remove(key, queue);
      },
    };
  }

  async onModuleDestroy(): Promise<void> {
    // eslint-disable-next-line no-await-in-loop -- shutdown, and there are at most eight.
    for (const reader of this.readers) await reader.close();
    this.readers.length = 0;
  }

  /** The reader already tracking this stream, or the emptiest one with room for it. */
  private readerFor(key: RedisKey): Reader {
    const tracking = this.readers.find((reader) => reader.has(key));
    if (tracking !== undefined) return tracking;

    const free = this.readers.find((reader) => reader.size < STREAMS_PER_READER);
    if (free !== undefined) return free;
    if (this.readers.length < MAX_READERS) return this.open();

    // Past the ceiling the streams pack in rather than being refused: a reader
    // with more keys than intended is slower, and a person who cannot watch
    // their own answer is broken.
    return this.readers.reduce((a, b) => (a.size <= b.size ? a : b));
  }

  private open(): Reader {
    const reader = new Reader(this.redis.createStreamReader(), this.logger);
    this.readers.push(reader);

    return reader;
  }

  private start(reader: Reader): void {
    if (reader.running) return;
    reader.begin(true);

    const spawned = this.tasks.spawn('stream-reader', async (signal) => {
      await reader.loop(signal, () => {
        this.start(reader);
      });
    });
    // Refused means the process is shutting down. Ending the subscriptions now
    // is what lets the connections close instead of waiting for a tail that is
    // never going to run.
    if (spawned) return;

    reader.begin(false);
    reader.closeAll();
  }
}

/**
 * One blocking read, shared by every stream it has been given. The cursors are
 * its own: nothing outside decides where it reads from, so two subscribers of
 * one stream cannot move each other's position.
 */
class Reader {
  private readonly cursors = new Map<RedisKey, string>();
  private readonly listeners = new Map<RedisKey, Set<AsyncQueue<StreamEntry>>>();
  private tailing = false;

  constructor(
    private readonly connection: StreamReader,
    private readonly logger: AppLogger,
  ) {}

  get running(): boolean {
    return this.tailing;
  }

  get size(): number {
    return this.cursors.size;
  }

  has(key: RedisKey): boolean {
    return this.cursors.has(key);
  }

  track(key: RedisKey, from: string): void {
    if (!this.cursors.has(key)) this.cursors.set(key, from);
  }

  add(key: RedisKey, queue: AsyncQueue<StreamEntry>): void {
    this.listenersOf(key).add(queue);
  }

  remove(key: RedisKey, queue: AsyncQueue<StreamEntry>): void {
    queue.close();
    const queues = this.listenersOf(key);
    queues.delete(queue);
    if (queues.size > 0) return;

    // Nobody is watching, so the stream leaves the next read. Its cursor goes
    // with it: whoever attaches later starts from wherever it has got to then.
    this.listeners.delete(key);
    this.cursors.delete(key);
  }

  begin(tailing: boolean): void {
    this.tailing = tailing;
  }

  closeAll(): void {
    for (const queues of this.listeners.values()) for (const queue of queues) queue.close();
  }

  async close(): Promise<void> {
    this.closeAll();
    await this.connection.close();
  }

  async loop(signal: AbortSignal, restart: () => void): Promise<void> {
    try {
      /* eslint-disable no-await-in-loop -- one read at a time is the point: the
         call blocks until something arrives, and a second in flight would be
         asking from a position the first has not answered from yet. */
      while (!signal.aborted && this.cursors.size > 0) {
        await this.tail();
      }
      /* eslint-enable no-await-in-loop */
    } finally {
      this.tailing = false;
      // Something may have attached while the last read was in flight, and this
      // is the only place that would notice it had been left without a tail.
      if (!signal.aborted && this.cursors.size > 0) restart();
    }
  }

  private async tail(): Promise<void> {
    try {
      const slices = await this.connection.read({
        cursors: new Map(this.cursors),
        blockMs: BLOCK_MS,
        count: BATCH,
      });

      for (const slice of slices) this.deliver(slice);
    } catch (error) {
      // A stream this process cannot read is a Redis problem, not a reason to
      // stop tailing every other one. Waiting a moment keeps a hard failure from
      // becoming a spin.
      this.logger.warn('reading the generation stream failed', {
        scope: 'StreamMultiplexer',
        err: asError(error),
      });
      await delay(AFTER_FAILURE_MS);
    }
  }

  private deliver(slice: StreamSlice): void {
    const queues = this.listeners.get(slice.key);
    // The last reader left while this read was in flight, so `remove` has
    // already taken the stream out. Advancing its cursor would put it straight
    // back — `set` on a key that is gone adds it — and nothing would ever take
    // it out again: one place in the sixty-four spent for the life of the
    // process, every time somebody closes a tab mid-answer.
    if (queues === undefined) return;

    const last = slice.entries.at(-1);
    if (last !== undefined) this.cursors.set(slice.key, last.id);

    for (const queue of queues) {
      for (const entry of slice.entries) queue.push(entry);
    }
  }

  private listenersOf(key: RedisKey): Set<AsyncQueue<StreamEntry>> {
    const existing = this.listeners.get(key);
    if (existing !== undefined) return existing;

    const queues = new Set<AsyncQueue<StreamEntry>>();
    this.listeners.set(key, queues);

    return queues;
  }
}
