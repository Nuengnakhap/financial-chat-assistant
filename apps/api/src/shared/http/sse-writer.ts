import type { ServerResponse } from 'node:http';

/**
 * Writing server-sent events to a socket that may not be keeping up.
 *
 * Ignoring what `write` returns is the shortcut that turns one phone on a weak
 * signal into unbounded memory in this process: Node buffers whatever the socket
 * has not taken, for as long as it takes. So every frame checks how much is
 * already queued, waits for the socket to drain before adding more, and gives up
 * on a reader that is too far behind to catch up.
 *
 * Giving up costs that reader nothing. A generation is not attached to this
 * connection — it is being written to Redis either way — so a cut client
 * reattaches with the last id it saw and carries on from there.
 */

/** About a minute of a fast answer. Past it, this reader is not going to catch up. */
const MAX_QUEUED_BYTES = 1_000_000;

export class SseWriter {
  constructor(private readonly response: ServerResponse) {}

  /**
   * `no-transform` as well as `no-cache`: a proxy that compresses the response
   * buffers it, and a buffered event stream is a stream that arrives all at once
   * at the end. `X-Accel-Buffering` says the same thing to nginx, which does it
   * anyway.
   */
  open(): void {
    this.response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Some proxies forward nothing until the first byte arrives, which would
    // hold the whole connection open unopened.
    this.response.write(':\n\n');
  }

  /**
   * False when the reader is too far behind and the caller should stop writing.
   *
   * Events are sent unnamed. A named one only reaches a client that called
   * `addEventListener` for that exact name, so a server adding an event would go
   * unheard by every older client — the opposite of the rule the contract is
   * built on, where an unknown event is skipped and everything else still works.
   * The type is inside the payload, where the parser reads it.
   */
  async write(id: string | null, payload: unknown): Promise<boolean> {
    if (this.response.writableLength > MAX_QUEUED_BYTES) return false;

    const frame = `${id === null ? '' : `id: ${id}\n`}data: ${JSON.stringify(payload)}\n\n`;
    if (!this.response.write(frame)) await this.drained();

    return true;
  }

  /** A comment: it keeps intermediaries from timing out an idle connection, and nothing reads it. */
  keepAlive(): boolean {
    return this.response.write(':\n\n');
  }

  end(): void {
    this.response.end();
  }

  private async drained(): Promise<void> {
    await new Promise<void>((resolve) => {
      // Both, because a socket that is closed will never drain and the wait
      // would otherwise be for ever.
      this.response.once('drain', resolve);
      this.response.once('close', resolve);
    });
  }
}
