import { Redis } from 'ioredis';

import type { RedisKey } from './keys';
import type {
  ChannelSubscriber,
  StreamEntry,
  StreamReadRequest,
  StreamReader,
  StreamSlice,
} from './stream-reader';

/**
 * The two ioredis clients that cannot be the shared one, and the only code that
 * knows what the wire format of a stream entry is.
 *
 * Every entry is written as one field, `e`, holding a JSON string. A stream
 * where each event is spread across named fields would let a reader think it
 * understood an event it only half recognised; one field means an entry is
 * either parsed whole by the layer above or refused.
 */

const FIELD = 'e';

export function createStreamReader(url: string, onError: (error: Error) => void): StreamReader {
  const client = connect(url, onError);

  return {
    read: async (request: StreamReadRequest): Promise<readonly StreamSlice[]> => {
      const keys = [...request.cursors.keys()];
      if (keys.length === 0) return [];

      const answer: unknown = await client.xread(
        'COUNT',
        request.count,
        'BLOCK',
        request.blockMs,
        'STREAMS',
        ...keys,
        ...keys.map((key) => request.cursors.get(key) ?? '0-0'),
      );

      return toSlices(answer);
    },
    close: async () => {
      await release(client);
    },
  };
}

export function createChannelSubscriber(
  url: string,
  onError: (error: Error) => void,
): ChannelSubscriber {
  const client = connect(url, onError);
  const handlers = new Map<string, (message: string) => void>();

  client.on('message', (channel: string, message: string) => {
    handlers.get(channel)?.(message);
  });

  return {
    subscribe: async (channel: RedisKey, handler: (message: string) => void) => {
      handlers.set(channel, handler);
      await client.subscribe(channel);
    },
    unsubscribe: async (channel: RedisKey) => {
      handlers.delete(channel);
      await client.unsubscribe(channel);
    },
    close: async () => {
      handlers.clear();
      await release(client);
    },
  };
}

/**
 * `maxRetriesPerRequest: null` where the shared client uses 1: a blocking read
 * and a subscription are meant to sit there for minutes, and the default would
 * abandon them during a reconnect rather than resume.
 */
function connect(url: string, onError: (error: Error) => void): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: null });
  client.on('error', onError);

  return client;
}

async function release(client: Redis): Promise<void> {
  // A blocked client cannot answer QUIT until its block expires, and shutdown is
  // already on a clock. Dropping the socket is what closing one of these means.
  client.disconnect();
  await Promise.resolve();
}

/**
 * Shaped rather than asserted. What comes back is `[key, [[id, [field, value]]]]`
 * nested four deep, and every level of it is a claim by the driver's types about
 * bytes that arrived from outside this process.
 */
export function toSlices(answer: unknown): readonly StreamSlice[] {
  if (!Array.isArray(answer)) return [];

  const slices: StreamSlice[] = [];
  for (const stream of answer) {
    if (!Array.isArray(stream)) continue;
    const key: unknown = stream[0];
    const rows: unknown = stream[1];
    if (typeof key !== 'string' || !Array.isArray(rows)) continue;

    slices.push({ key: asKey(key), entries: toEntries(rows) });
  }

  return slices;
}

export function toEntries(rows: readonly unknown[]): readonly StreamEntry[] {
  const entries: StreamEntry[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const id: unknown = row[0];
    const fields: unknown = row[1];
    if (typeof id !== 'string' || !Array.isArray(fields)) continue;

    const payload = valueOf(fields);
    if (payload !== null) entries.push({ id, payload });
  }

  return entries;
}

function valueOf(fields: readonly unknown[]): string | null {
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const value = fields[index + 1];
    if (fields[index] === FIELD && typeof value === 'string') return value;
  }

  return null;
}

/** The key came back from Redis having been given to it as one. */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
const asKey = (value: string): RedisKey => value as RedisKey;
/* eslint-enable @typescript-eslint/consistent-type-assertions */

export const STREAM_FIELD = FIELD;
