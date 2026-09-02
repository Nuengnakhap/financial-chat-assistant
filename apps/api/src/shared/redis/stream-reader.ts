import type { RedisKey } from './keys';

/**
 * The two connections that cannot be the shared one.
 *
 * A blocking read holds the socket for as long as it blocks, and a subscriber
 * connection is not allowed to run ordinary commands at all — so both need a
 * client of their own. They are declared as interfaces here so that everything
 * above `shared/redis` can be built and tested against them without ioredis
 * being anywhere in the picture.
 */

export interface StreamEntry {
  /** The Redis stream id, which is also what a client sends back as `Last-Event-ID`. */
  readonly id: string;
  readonly payload: string;
}

export interface StreamSlice {
  readonly key: RedisKey;
  readonly entries: readonly StreamEntry[];
}

export interface StreamReadRequest {
  /** Positions, one per key and in the same order: everything after each is returned. */
  readonly cursors: ReadonlyMap<RedisKey, string>;
  readonly blockMs: number;
  readonly count: number;
}

export interface StreamReader {
  /** Empty when the block expired with nothing new, which is the ordinary case. */
  read(request: StreamReadRequest): Promise<readonly StreamSlice[]>;
  close(): Promise<void>;
}

export interface ChannelSubscriber {
  subscribe(channel: RedisKey, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: RedisKey): Promise<void>;
  close(): Promise<void>;
}

/** How much of a stream is kept, and for how long after the last thing written to it. */
export interface StreamRetention {
  readonly maxLength: number;
  readonly ttlSeconds: number;
}

/**
 * Ids are `<milliseconds>-<sequence>`, so comparing them as strings puts
 * `10-0` before `9-0`. Both halves are compared as numbers instead.
 */
export function isAfter(id: string, other: string): boolean {
  const [ms, sequence] = partsOf(id);
  const [otherMs, otherSequence] = partsOf(other);

  return ms === otherMs ? sequence > otherSequence : ms > otherMs;
}

/**
 * A half that is not a number reads as zero — the beginning — rather than as
 * `NaN`, which compares false against everything and would quietly drop every
 * entry a reader was given. Nothing should ever produce one, since these come
 * from Redis; the point is that the failure would be silence, and silence in the
 * middle of an answer is the one failure this system must not have.
 */
function partsOf(id: string): readonly [number, number] {
  const [ms, sequence] = id.split('-');

  return [whole(ms), whole(sequence)];
}

function whole(part: string | undefined): number {
  const value = Number(part);

  return Number.isFinite(value) ? value : 0;
}
