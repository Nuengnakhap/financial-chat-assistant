import type { StreamEvent } from '@fca/contracts';
import type { MessageId } from '@fca/domain';

/**
 * Where a generation's events go, and where a client reads them from.
 *
 * The runner never writes to a socket. Everything it produces goes here first,
 * which is what lets a generation outlive the request that asked for it: closing
 * a tab, losing a signal or picking the conversation up on another device
 * changes who is reading, not whether the answer is still being written.
 */

/** The beginning of a stream, and what a client that has seen nothing asks from. */
export const STREAM_START = '0-0';

export interface StoredStreamEvent {
  /**
   * The id a client sends back as `Last-Event-ID`. Null for an event the server
   * made up rather than read — one of those must never move a client's cursor,
   * because there is nothing behind it to resume from.
   */
  readonly id: string | null;
  readonly event: StreamEvent;
}

export interface GenerationEvents {
  append(messageId: MessageId, event: StreamEvent): Promise<void>;
  /**
   * Everything after `afterId`, then everything that happens next, ending at the
   * generation's terminal event or when the caller lets go of the signal.
   */
  read(
    messageId: MessageId,
    afterId: string,
    signal: AbortSignal,
  ): AsyncGenerator<StoredStreamEvent>;
  /** Everything on the stream as it stands, waiting for nothing. */
  replay(messageId: MessageId): Promise<readonly StoredStreamEvent[]>;
  /**
   * When the last event was written, or null for a generation that has produced
   * nothing yet. This is what says a runner is still alive: a process that died
   * mid-answer stops writing, and so does one that is wedged.
   */
  lastActivityAt(messageId: MessageId): Promise<Date | null>;
}

export const GENERATION_EVENTS = Symbol('GenerationEvents');
