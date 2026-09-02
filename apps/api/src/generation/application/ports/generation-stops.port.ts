import type { MessageId } from '@fca/domain';

/**
 * How a stop reaches the generation it is about.
 *
 * Stopping is not disconnecting. A closed tab, a dead connection or a refresh
 * leave the answer being written — that is the whole point of a durable stream —
 * so the only thing that ends one early is somebody asking, and the request that
 * asks is almost never handled by the process doing the writing. This is the one
 * hop between the two.
 */
export interface GenerationStops {
  /**
   * Registers a generation as running here and returns the signal that fires
   * when a stop for it arrives, from this process or any other.
   */
  hold(messageId: MessageId): Promise<AbortSignal>;
  /** Always called, however the generation ended, or the pod keeps listening for it. */
  release(messageId: MessageId): Promise<void>;
  /** Reaches whoever is holding it. Nobody holding it means there is nothing to stop. */
  request(messageId: MessageId): Promise<void>;
}

export const GENERATION_STOPS = Symbol('GenerationStops');
