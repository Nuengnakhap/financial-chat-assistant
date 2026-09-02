import type { MessageId } from '@fca/domain';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';

import { K } from '../../shared/redis/keys';
import { RedisService } from '../../shared/redis/redis.service';
import type { ChannelSubscriber } from '../../shared/redis/stream-reader';
import type { GenerationStops } from '../application/ports/generation-stops.port';

/**
 * A stop, carried over Redis to whichever process is generating.
 *
 * Published rather than written: a stop matters only to a generation that is
 * running right now, and one that has already finished has nothing to be told.
 * That is why there is no key to clean up afterwards and no state for a stop
 * that arrived a moment too late — it reaches nobody and the answer stands,
 * which is exactly what happened.
 *
 * One subscriber connection for the process, subscribed only to the channels of
 * the generations this process is actually running.
 */
@Injectable()
export class RedisGenerationStops implements GenerationStops, OnModuleDestroy {
  private readonly running = new Map<MessageId, AbortController>();
  private subscriber: ChannelSubscriber | null = null;

  constructor(private readonly redis: RedisService) {}

  async hold(messageId: MessageId): Promise<AbortSignal> {
    const controller = new AbortController();
    this.running.set(messageId, controller);

    await this.channel().subscribe(K.streamStop(messageId), () => {
      controller.abort();
    });

    return controller.signal;
  }

  async release(messageId: MessageId): Promise<void> {
    this.running.delete(messageId);
    await this.subscriber?.unsubscribe(K.streamStop(messageId));
  }

  async request(messageId: MessageId): Promise<void> {
    await this.redis.publish(K.streamStop(messageId), 'stop');
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.close();
    this.subscriber = null;
    this.running.clear();
  }

  /**
   * Opened on the first generation this process runs rather than at boot: a
   * subscriber connection cannot run ordinary commands, so it is a whole client
   * held open for something a process may never do.
   */
  private channel(): ChannelSubscriber {
    this.subscriber ??= this.redis.createChannelSubscriber();

    return this.subscriber;
  }
}
