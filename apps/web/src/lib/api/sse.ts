import { parseStreamEvent, type StreamEvent } from '@fca/contracts';

import { openStream } from './http';

/**
 * Reading a server-sent event stream.
 *
 * Not `EventSource`, for two reasons that both matter here. It cannot set a
 * header, and `Last-Event-ID` on the *first* connection is the whole of resuming
 * after a refresh — the browser only sends it on reconnections it made itself,
 * and a page that has just loaded has none. And it reconnects on its own
 * schedule, which would race the backoff the caller needs to own.
 *
 * What comes back is parsed by the contract's own reader, so an event this build
 * does not know is skipped rather than fatal: a server that has shipped a new
 * one keeps working with a tab that was opened before it.
 */

export interface StreamFrame {
  /** The position to resume from. Null for an event the server made up. */
  readonly id: string | null;
  readonly event: StreamEvent;
}

/** Two newlines end a frame; the last piece of a chunk is usually half of one. */
const FRAME_END = '\n\n';

export async function* attach(
  path: string,
  lastEventId: string | null,
  signal: AbortSignal,
): AsyncGenerator<StreamFrame> {
  const body = await openStream(path, lastEventId, signal);

  for await (const frame of frames(body)) {
    const parsed = toFrame(frame);
    if (parsed !== null) yield parsed;
  }
}

/**
 * The stream cut into frames. Whatever follows the last separator is the start
 * of the next frame rather than a frame: a delta arrives split across chunks
 * often enough that treating it as complete would put half an event on screen.
 */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  // `stream: true` so a multi-byte character split across two chunks is held
  // rather than decoded as two broken ones — which is what a company name with
  // an accent in it would arrive as.
  const decoder = new TextDecoder();
  let pending = '';

  try {
    for (;;) {
      /* A stream is read one chunk at a time: there is no next chunk to ask for
         until this one has arrived. */
      // eslint-disable-next-line no-await-in-loop -- see above
      const { done, value } = await reader.read();
      if (done) return;

      pending += decoder.decode(value, { stream: true });
      const parts = pending.split(FRAME_END);
      pending = parts.pop() ?? '';

      yield* parts;
    }
  } finally {
    // Releasing rather than cancelling: the caller's signal is what ends the
    // request, and cancelling a reader whose stream is already gone throws.
    reader.releaseLock();
  }
}

/**
 * Null for a comment — the keep-alive that stops an idle connection being timed
 * out is a frame with no data — and for anything this build cannot read.
 */
function toFrame(frame: string): StreamFrame | null {
  let id: string | null = null;
  let data: string | null = null;

  for (const line of frame.split('\n')) {
    if (line.startsWith('id: ')) id = line.slice(4);
    if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (data === null) return null;

  const event = read(data);

  return event === null ? null : { id, event };
}

function read(data: string): StreamEvent | null {
  try {
    return parseStreamEvent(JSON.parse(data));
  } catch {
    return null;
  }
}
