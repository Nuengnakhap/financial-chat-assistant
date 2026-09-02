import { isTerminalStreamEvent, type StreamEvent } from '@fca/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { IDLE, generatingId, reduce, type GenerationState } from './generation.state';
import { askQuestion, stopGenerating, streamPathFor, watchGeneration } from '../api/generation';

import { ApiError, messageFor } from '@/lib/api/errors';

/**
 * Asking, watching and stopping — the three things a page does with a
 * generation, and only the first of them starts one.
 *
 * The connection is not the work. Losing it means reconnecting from the last
 * event this page saw, and the answer carried on being written in the meantime;
 * closing the page means nothing at all. That is why the loop below reconnects
 * on its own rather than reporting a failure, and why stopping is a request to
 * the server instead of a socket being closed.
 *
 * The query cache is not touched until the end. Invalidating mid-stream would
 * re-render the whole history for every delta, and the answer is not in the
 * history until it is finished anyway.
 */

/** Half a second, doubling, up to eight — about as long as anyone waits before reloading. */
const FIRST_BACKOFF_MS = 500;
const LONGEST_BACKOFF_MS = 8_000;

/** Past this the page stops trying by itself and says so. */
const MAX_ATTEMPTS = 8;

export interface Generation {
  readonly state: GenerationState;
  send: (content: string) => void;
  stop: () => void;
  /** Attaches to an answer that was already being written when this page loaded. */
  resume: (assistantMessageId: string) => void;
}

export function useGeneration(conversationId: string): Generation {
  const [state, dispatch] = useReducer(reduce, IDLE);
  const refresh = useRefreshedHistory(conversationId);
  const attachment = useAttachment(conversationId);
  const finish = useCallback(
    (event: StreamEvent) => {
      attachment.stop();
      refresh();
      dispatch(ending(event));
    },
    [refresh, attachment],
  );

  const watching = useRef<string | null>(null);
  const watch = useCallback(
    async (assistantMessageId: string) => {
      // Already reading this one, and the connection is still there to read it
      // with. Attaching again would put two readers on the same stream and
      // dispatch every event twice.
      if (watching.current === assistantMessageId && attachment.isOpen()) return;

      watching.current = assistantMessageId;
      const signal = attachment.start();
      dispatch({ type: 'watch', assistantMessageId });
      await follow({ path: streamPathFor(assistantMessageId), signal, dispatch, finish });
    },
    [finish, attachment],
  );

  const send = useCallback(
    (content: string) => {
      dispatch({ type: 'ask', question: content });
      void ask(conversationId, content, { dispatch, watch });
    },
    [conversationId, watch],
  );

  const stop = useCallback(() => {
    stopFor(state);
  }, [state]);
  return { state, send, stop, resume: useResume(watch) };
}

/**
 * Attaching to an answer already in flight, for a caller with nothing to wait
 * for: the effect that finds an unfinished message is telling this hook to
 * start reading, not asking it how the reading went.
 */
function useResume(watch: (assistantMessageId: string) => Promise<void>): (id: string) => void {
  return useCallback(
    (assistantMessageId: string) => {
      void watch(assistantMessageId);
    },
    [watch],
  );
}

/**
 * What the end of a stream means for the page. A generation that failed says so
 * in the words the server chose; one that finished says nothing at all, because
 * everything about it — its text, its report, its status — is in the message
 * that was stored, which the history is about to read.
 */
function ending(event: StreamEvent): Parameters<typeof reduce>[1] {
  return event.type === 'error' ? { type: 'failed', message: event.message } : { type: 'idle' };
}

/**
 * Nothing local happens: the request reaches whichever process is writing, and
 * the end of the answer arrives down the stream like everything else.
 *
 * A request that fails is left alone rather than reported. The answer is still
 * being written, which is exactly what the screen still shows, and the button
 * is still there to press again — turning this into a failure would clear a
 * view that is perfectly correct.
 */
function stopFor(state: GenerationState): void {
  const id = generatingId(state);
  if (id !== null) void stopGenerating(id).catch(() => undefined);
}

interface Attachment {
  start: () => AbortSignal;
  stop: () => void;
  /** True while there is a connection being read, rather than one that has been let go. */
  isOpen: () => boolean;
}

/**
 * The one connection this page has open.
 *
 * Leaving the page does not stop the generation — it stops this page reading it.
 * Nothing here cancels the work; the request is simply let go of, and whoever
 * opens the conversation next attaches to whatever it has become.
 *
 * Whether one is open is asked rather than remembered, because a page settling
 * is allowed to take it away: React mounts every effect, tears it down and
 * mounts it again in development, and the teardown aborts whatever the first
 * pass attached. A page that remembered only that it had attached once would
 * hold a connection that no longer exists.
 */
function useAttachment(conversationId: string): Attachment {
  const open = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    open.current?.abort();
    open.current = null;
  }, []);

  const start = useCallback(() => {
    // At most one at a time: a second would read the same events beside the
    // first and dispatch every one of them twice.
    stop();
    const next = new AbortController();
    open.current = next;

    return next.signal;
  }, [stop]);

  const isOpen = useCallback(() => open.current !== null && !open.current.signal.aborted, []);

  useEffect(() => stop, [stop, conversationId]);

  return useMemo(() => ({ start, stop, isOpen }), [start, stop, isOpen]);
}

type Dispatch = (action: Parameters<typeof reduce>[1]) => void;

interface Asking {
  readonly dispatch: Dispatch;
  readonly watch: (assistantMessageId: string) => Promise<void>;
}

/**
 * The command, and then the stream it answered with.
 *
 * Nothing is read back in between. The question is a row the moment the server
 * accepts it, but reading it now would mean showing the same question twice —
 * once as the row and once as what is being asked — so the page keeps its own
 * copy until the answer is a row as well and both arrive together.
 */
async function ask(conversationId: string, content: string, asking: Asking): Promise<void> {
  try {
    const started = await askQuestion({
      conversationId,
      content,
      clientMessageId: crypto.randomUUID(),
    });
    await asking.watch(started.assistantMessageId);
  } catch (error) {
    asking.dispatch({ type: 'failed', message: messageFor(error) });
  }
}

/**
 * Reading the conversation again. Called once per generation, at the end: the
 * question and its answer become rows together, and touching the cache before
 * that would re-render the whole history for every delta of an answer that is
 * not in it yet.
 */
function useRefreshedHistory(conversationId: string): () => void {
  const queries = useQueryClient();

  return useCallback(() => {
    void queries.invalidateQueries({ queryKey: ['conversations', conversationId, 'messages'] });
    void queries.invalidateQueries({ queryKey: ['conversations'], exact: true });
  }, [conversationId, queries]);
}

interface Following {
  readonly path: string;
  readonly signal: AbortSignal;
  readonly dispatch: Dispatch;
  readonly finish: (event: StreamEvent) => void;
}

/**
 * Reads the stream until it ends, reconnecting from the last event seen. The
 * server keeps writing throughout, so a reconnection is a page catching up
 * rather than work being repeated.
 */
async function follow(following: Following): Promise<void> {
  let from: string | null = null;

  /* eslint-disable no-await-in-loop -- one connection at a time: a second would
     read the same events beside the first, and the wait between them is the
     backoff rather than an accident. */
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !following.signal.aborted; attempt += 1) {
    const outcome = await readOnce(following, from);
    if (outcome.ended) return;

    from = outcome.from;
    following.dispatch({ type: 'dropped', attempt: attempt + 1 });
    if (!(await waitBeforeRetrying(attempt, following.signal))) return;

    following.dispatch({ type: 'resumed' });
  }
  /* eslint-enable no-await-in-loop */

  if (!following.signal.aborted) {
    following.dispatch({ type: 'failed', message: 'The connection could not be re-established.' });
  }
}

interface Outcome {
  /** True when there is nothing more to read, however that came about. */
  readonly ended: boolean;
  /** Where to pick up from, which is where this attempt got to. */
  readonly from: string | null;
}

/**
 * One connection's worth. It ends either at the generation's terminal event —
 * which is the answer being over — or by the response finishing without one,
 * which is a pod draining or a proxy with its own idea of how long a response
 * may last, and is the caller's cue to attach again.
 */
async function readOnce(following: Following, from: string | null): Promise<Outcome> {
  let seen = from;

  try {
    for await (const frame of watchGeneration(following.path, seen, following.signal)) {
      seen = frame.id ?? seen;
      following.dispatch({ type: 'frame', frame });
      if (isTerminalStreamEvent(frame.event)) {
        following.finish(frame.event);
        return { ended: true, from: seen };
      }
    }
  } catch (error) {
    if (following.signal.aborted) return { ended: true, from: seen };
    if (wasRefused(error)) {
      following.dispatch({ type: 'failed', message: messageFor(error) });
      return { ended: true, from: seen };
    }
  }

  return { ended: false, from: seen };
}

/**
 * The loop above is for connections, and this is not one of those. A message
 * that is gone, or one that was never this person's, or a session that could not
 * be saved: the server understood the request and declined it, and asking eight
 * more times cannot make it answer differently.
 *
 * Written as the whole range rather than as the statuses this endpoint sends
 * today, so a refusal added to it later is not read as a dropped connection.
 * Anything from five hundred up, and anything with no response at all, stays
 * transient — that is a server or a wire having a bad moment.
 */
function wasRefused(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/** False when the wait was cut short, which only happens because the page has gone. */
async function waitBeforeRetrying(attempt: number, signal: AbortSignal): Promise<boolean> {
  const wait = Math.min(FIRST_BACKOFF_MS * 2 ** attempt, LONGEST_BACKOFF_MS);

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, wait);

    function onAbort(): void {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
