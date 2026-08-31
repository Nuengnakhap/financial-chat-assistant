import type { AppConfig } from '@fca/config';
import type { ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * BullMQ gets its own connections rather than sharing `RedisService`'s. A worker
 * holds a blocking read open for as long as the queue is empty, so a client
 * shared with the rest of the app would be a client that cannot answer anything
 * else — and BullMQ requires `maxRetriesPerRequest: null` for exactly that read,
 * which is the opposite of what a request-path client wants.
 *
 * A function rather than a value, because a `Queue` and a `Worker` each need one
 * of their own; handing the same client to both is how a worker's blocking read
 * stalls the producer.
 */
export function queueConnection(config: AppConfig): ConnectionOptions {
  return new Redis(config.redis.url, { maxRetriesPerRequest: null });
}
