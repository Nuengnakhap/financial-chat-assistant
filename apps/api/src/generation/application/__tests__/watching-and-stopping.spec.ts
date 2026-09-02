import type { MessageView } from '@fca/contracts';
import { ConversationId, MessageId, UserId, type MessageStatus } from '@fca/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerationEvents, StoredStreamEvent } from '../ports/generation-events.port';
import type { Answer, GenerationMessages } from '../ports/generation-messages.port';
import type { GenerationStops } from '../ports/generation-stops.port';
import { StopGenerationUseCase } from '../use-cases/stop-generation.use-case';
import { WatchGenerationUseCase } from '../use-cases/watch-generation.use-case';

/**
 * Watching an answer and asking it to stop: the two things done to a generation
 * that is not running in this request, and possibly not in this process.
 */

const ADA = UserId.trusted('e5c9f4a1-1f0e-4a6a-9d4e-0c8b6a3f21d0');
const GRACE = UserId.trusted('f1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a5b');
const ID = MessageId.trusted('a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d');

const answer = (status: MessageStatus, ownerId = ADA): Answer => ({
  id: ID,
  conversationId: ConversationId.trusted('cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21'),
  ownerId,
  seq: 2,
  status,
  startedAt: new Date('2026-09-02T10:00:00.000Z'),
});

/** A whole view, because the contract's own refinement insists on one. */
const storedMessage = (status: 'complete' | 'stopped'): MessageView => ({
  id: ID,
  conversationId: ConversationId.trusted('cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21'),
  seq: 2,
  role: 'assistant',
  status,
  parts: [{ kind: 'text', text: 'Apple earned $391.0B' }],
  verification:
    status === 'complete' ? { verdict: 'pass', checkedClaims: [], violations: [] } : null,
  usage: null,
  error: null,
  createdAt: '2026-09-02T10:00:00.000Z',
});

const STORED = storedMessage('complete');

const find = vi.fn();
const view = vi.fn();
const lastActivityAt = vi.fn();
const read = vi.fn();
const request = vi.fn();

const messages = { find, view } as unknown as GenerationMessages;
const events = { lastActivityAt, read } as unknown as GenerationEvents;
const stops = { request } as unknown as GenerationStops;

const watching = { afterId: '0-0', signal: new AbortController().signal };
const watch = () =>
  new WatchGenerationUseCase(messages, events).execute({ userId: ADA }, ID, watching);
const stop = () => new StopGenerationUseCase(messages, stops).execute({ userId: ADA }, ID);

async function collect(events_: AsyncIterable<StoredStreamEvent>): Promise<StoredStreamEvent[]> {
  const seen: StoredStreamEvent[] = [];
  for await (const stored of events_) seen.push(stored);

  return seen;
}

beforeEach(() => {
  vi.resetAllMocks();
  find.mockResolvedValue(answer('generating'));
  lastActivityAt.mockResolvedValue(new Date('2026-09-02T10:00:01.000Z'));
  read.mockReturnValue([]);
  view.mockResolvedValue(STORED);
});

describe('watching an answer', () => {
  it('reads the stream from where the client says it got to', async () => {
    await new WatchGenerationUseCase(messages, events).execute({ userId: ADA }, ID, {
      ...watching,
      afterId: '17-2',
    });

    expect(read).toHaveBeenCalledWith(ID, '17-2', watching.signal);
  });

  it('is refused for a message that belongs to somebody else', async () => {
    find.mockResolvedValue(answer('generating', GRACE));

    const refused = await watch();

    // The same answer as for a message that does not exist: saying "forbidden"
    // would confirm it is there.
    expect(!refused.ok && refused.error.code).toBe('not_found');
    expect(read).not.toHaveBeenCalled();
  });

  it('is refused for a message that is not there at all', async () => {
    find.mockResolvedValue(null);

    expect((await watch()).ok).toBe(false);
  });
});

describe('watching one that finished long enough ago for its stream to have gone', () => {
  beforeEach(() => {
    find.mockResolvedValue(answer('complete'));
    lastActivityAt.mockResolvedValue(null);
  });

  it('answers with the stored message, so the client is never left waiting', async () => {
    const seen = await watch();

    expect(seen.ok && (await collect(seen.value))).toEqual([
      // No id: there is no position in a stream that no longer exists, and a
      // client must not come back asking to resume from one.
      { id: null, event: { type: 'message_complete', message: STORED } },
    ]);
    expect(read).not.toHaveBeenCalled();
  });

  it('still reads the stream while the answer is being written', async () => {
    // A running generation always has a stream, so the absence of one says
    // nothing until the message itself says it has ended.
    find.mockResolvedValue(answer('generating'));

    await watch();

    expect(read).toHaveBeenCalled();
  });

  it('ends quietly when even the row is gone', async () => {
    view.mockResolvedValue(null);

    const seen = await watch();

    expect(seen.ok && (await collect(seen.value))).toEqual([]);
  });
});

describe('asking an answer to stop', () => {
  it('sends the request to whoever is writing it', async () => {
    expect((await stop()).ok).toBe(true);
    expect(request).toHaveBeenCalledWith(ID);
  });

  it('is refused for somebody else’s message, without telling them it exists', async () => {
    find.mockResolvedValue(answer('generating', GRACE));

    const refused = await stop();

    expect(!refused.ok && refused.error.code).toBe('not_found');
    expect(request).not.toHaveBeenCalled();
  });

  it('succeeds without asking anyone when the answer has already finished', async () => {
    find.mockResolvedValue(answer('complete'));

    // Whoever asked wanted it to not be running, and it is not running. A
    // failure here would make a client handle a race it cannot win.
    expect((await stop()).ok).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
