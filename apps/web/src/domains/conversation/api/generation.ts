import { messagesContract, type StartGenerationResponse } from '@fca/contracts';

import { api } from '@/lib/api/client';
import { attach, type StreamFrame } from '@/lib/api/sse';

/**
 * The three calls a generation takes: ask, watch, and stop.
 *
 * Watching is separate from asking because it happens far more often than
 * asking does — a refresh, a second tab, a phone waking up on a train all watch
 * something they never started, and after the first token they are all the same
 * request.
 */

export interface Question {
  readonly conversationId: string;
  readonly content: string;
  /** The browser's own id for this send, which makes a retry reach one message. */
  readonly clientMessageId: string;
}

export async function askQuestion(question: Question): Promise<StartGenerationResponse> {
  return await api.messages.startGeneration({
    params: { id: question.conversationId },
    body: { content: question.content, clientMessageId: question.clientMessageId },
  });
}

/**
 * Asks for the writing to stop. Nothing here waits for it: what comes back is
 * an acknowledgement that the request was sent, and the end of the answer
 * arrives down the stream like everything else.
 */
export async function stopGenerating(assistantMessageId: string): Promise<void> {
  await api.messages.stop({ params: { id: assistantMessageId } });
}

/**
 * Everything after `lastEventId`, then everything that happens next. Where a
 * client got to is a position in the stream, not a count, so resuming after an
 * hour and attaching for the first time are the same call with a different
 * argument.
 */
export function watchGeneration(
  streamPath: string,
  lastEventId: string | null,
  signal: AbortSignal,
): AsyncIterable<StreamFrame> {
  return attach(streamPath, lastEventId, signal);
}

/**
 * Built from the contract rather than remembered, so a page that resumed after a
 * refresh needs only the row — and the path it asks for is the same string the
 * server answered with when the question was first sent.
 */
export function streamPathFor(assistantMessageId: string): string {
  return messagesContract.stream.path.replace(':id', encodeURIComponent(assistantMessageId));
}
