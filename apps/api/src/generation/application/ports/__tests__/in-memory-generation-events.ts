import type { StreamEvent } from '@fca/contracts';
import { isTerminalStreamEvent } from '@fca/contracts';
import type { MessageId } from '@fca/domain';

import {
  STREAM_START,
  type GenerationEvents,
  type StoredStreamEvent,
} from '../generation-events.port';

/**
 * A second implementation, which is what makes the contract suite next door a
 * suite rather than one adapter's tests wearing a hat.
 *
 * It is not here to be used. It is here so that every sentence in the contract
 * has to be true of something other than Redis — and the first thing that goes
 * wrong when a suite only ever runs against one adapter is that it starts
 * asserting that adapter's incidental behaviour and nobody notices until the
 * second one arrives.
 */

interface Entry {
  readonly id: string;
  readonly event: StreamEvent;
}

/**
 * The same shape Redis uses, `<milliseconds>-<sequence>`, because the id is not
 * an implementation detail: a client sends it back as `Last-Event-ID`, and both
 * halves are compared as numbers.
 */
function isAfter(id: string, cursor: string): boolean {
  const [milliseconds, sequence] = id.split('-').map(Number);
  const [sinceMs, sinceSeq] = cursor.split('-').map(Number);

  if ((milliseconds ?? 0) !== (sinceMs ?? 0)) return (milliseconds ?? 0) > (sinceMs ?? 0);

  return (sequence ?? 0) > (sinceSeq ?? 0);
}

export class InMemoryGenerationEvents implements GenerationEvents {
  private readonly entries = new Map<string, Entry[]>();
  private readonly waiting = new Map<string, Set<() => void>>();
  private lastMilliseconds = 0;
  private sequence = 0;

  append(messageId: MessageId, event: StreamEvent): Promise<void> {
    const list = this.entries.get(messageId) ?? [];
    list.push({ id: this.nextId(), event });
    this.entries.set(messageId, list);

    for (const wake of this.waiting.get(messageId) ?? []) wake();

    return Promise.resolve();
  }

  replay(messageId: MessageId): Promise<readonly StoredStreamEvent[]> {
    const stored: StoredStreamEvent[] = [];

    for (const entry of this.entries.get(messageId) ?? []) {
      stored.push({ id: entry.id, event: entry.event });
      if (isTerminalStreamEvent(entry.event)) break;
    }

    return Promise.resolve(stored);
  }

  lastActivityAt(messageId: MessageId): Promise<Date | null> {
    const list = this.entries.get(messageId) ?? [];
    const last = list.at(-1);
    if (last === undefined) return Promise.resolve(null);

    const [milliseconds] = last.id.split('-');

    return Promise.resolve(new Date(Number(milliseconds)));
  }

  async *read(
    messageId: MessageId,
    afterId: string,
    signal: AbortSignal,
  ): AsyncGenerator<StoredStreamEvent> {
    let cursor = afterId === '' ? STREAM_START : afterId;

    while (!signal.aborted) {
      for (const entry of this.entries.get(messageId) ?? []) {
        if (!isAfter(entry.id, cursor)) continue;
        cursor = entry.id;

        yield { id: entry.id, event: entry.event };
        if (isTerminalStreamEvent(entry.event)) return;
      }

      // Nothing to ask for until something is written, which is the shape of
      // a live tail.
      await this.somethingHappens(messageId, signal);
    }
  }

  private nextId(): string {
    const milliseconds = Math.max(Date.now(), this.lastMilliseconds);
    this.sequence = milliseconds === this.lastMilliseconds ? this.sequence + 1 : 0;
    this.lastMilliseconds = milliseconds;

    return `${String(milliseconds)}-${String(this.sequence)}`;
  }

  private async somethingHappens(messageId: MessageId, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;

    await new Promise<void>((resolve) => {
      const wake = (): void => {
        this.waiting.get(messageId)?.delete(wake);
        signal.removeEventListener('abort', wake);
        resolve();
      };

      const waiters = this.waiting.get(messageId) ?? new Set<() => void>();
      waiters.add(wake);
      this.waiting.set(messageId, waiters);
      signal.addEventListener('abort', wake, { once: true });
    });
  }
}
