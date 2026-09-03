import type { MessageView } from '@fca/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';

import { Answer } from './Answer';
import { Composer } from './Composer';
import { messagesInOrder, messagesQuery } from '../api/messages';
import { useGeneration } from '../hooks/useGeneration';
import { useReachedEdge } from '../hooks/useReachedEdge';

import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Skeleton } from '@/components/Skeleton';
import { useUsage } from '@/domains/usage';
import { ApiError, messageFor } from '@/lib/api/errors';

/**
 * One conversation: what has been said, what is being written, and the box the
 * next question goes in.
 *
 * The three are one component because they are one thing to a reader and because
 * the middle one only exists in relation to the others — an answer being written
 * belongs at the end of the transcript, and the composer refuses while it is.
 *
 * An answer already in flight when this page loads is picked up rather than
 * waited for: the history says a message is `generating`, and attaching to its
 * stream replays what was written before the refresh and then carries on.
 */
export interface ChatRoomProps {
  readonly conversationId: string;
  /**
   * Asked as soon as the room opens. A question typed on the empty screen makes
   * the conversation first and arrives here with it, so what somebody wrote is
   * never lost between one screen and the next.
   */
  readonly opening?: string | undefined;
}

export function ChatRoom({ conversationId, opening }: ChatRoomProps) {
  const history = useInfiniteQuery(messagesQuery(conversationId));
  const generation = useGeneration(conversationId);
  const sentinel = useReachedEdge(history.hasNextPage && !history.isFetchingNextPage, () => {
    void history.fetchNextPage();
  });
  const gone = history.isError && history.error instanceof ApiError && history.error.status === 404;
  useLeaveWhenGone(gone);

  const messages = history.isSuccess ? messagesInOrder(history.data.pages) : [];
  useResumeUnfinished(messages, generation.resume);
  useAsksTheOpeningQuestion(opening, generation);
  const scroll = useRef<HTMLDivElement>(null);
  // Both, because either can add to the end: a delta arriving, and the finished
  // message taking its place in the history.
  useFollowsTheEnd({ scroll, conversationId, at: messages.length, state: generation.state });
  const retry = (): void => {
    void history.refetch();
  };

  return (
    <>
      <div
        ref={scroll}
        /* `pr-6` is not symmetry for its own sake: this is the element that
           scrolls, so the scrollbar is drawn on its right edge — over the
           content on a platform with overlay scrollbars. A figure whose last
           column ends underneath the scrollbar reads as cut off. `pl-6` keeps
           the text where the eye expects it, aligned with the composer below. */
        className="mx-auto min-h-0 w-full max-w-room flex-1 overflow-y-auto px-6"
      >
        {history.isPending && <Loading />}
        {history.isError && !gone && <Unreadable error={history.error} onRetry={retry} />}
        {history.isSuccess && (
          <Transcript
            messages={messages}
            sentinel={sentinel}
            loadingOlder={history.isFetchingNextPage}
            generation={generation}
          />
        )}
      </div>
      <Ask generation={generation} />
    </>
  );
}

function Ask({ generation }: { readonly generation: Generation }) {
  const usage = useUsage();

  return (
    <Composer
      busy={isBusy(generation)}
      // Shut while the window is spent. The server would refuse it anyway, and
      // being refused after typing a question is a worse way to find out.
      spent={usage?.exceeded === true}
      onSend={generation.send}
      onStop={canStop(generation) ? generation.stop : undefined}
    />
  );
}

type Generation = ReturnType<typeof useGeneration>;

const isBusy = (generation: Generation): boolean =>
  generation.state.phase !== 'idle' && generation.state.phase !== 'failed';

const canStop = (generation: Generation): boolean =>
  generation.state.phase === 'streaming' || generation.state.phase === 'reconnecting';

interface TranscriptProps {
  readonly messages: readonly MessageView[];
  readonly sentinel: (node: Element | null) => void;
  readonly loadingOlder: boolean;
  readonly generation: Generation;
}

function Transcript({ messages, sentinel, loadingOlder, generation }: TranscriptProps) {
  const { state } = generation;
  // The message the stream is writing into is already in the history as an empty
  // `generating` row. Drawing both would be the same answer twice, once blank.
  const written =
    state.phase === 'streaming' || state.phase === 'reconnecting'
      ? messages.filter((message) => message.id !== state.assistantMessageId)
      : messages;

  if (written.length === 0 && state.phase === 'idle') return <Empty />;

  return (
    <ol role="log" aria-live="polite" aria-label="Conversation" className="flex flex-col gap-8">
      {/* Above the oldest message, because that is the direction this list
          grows: reaching the top is what asks for what came before. */}
      <li ref={sentinel} aria-hidden="true">
        {loadingOlder && <Skeleton className="h-4 w-24" />}
      </li>
      {written.map((message) => (
        <Message key={message.id} message={message} />
      ))}
      <Live state={state} />
    </ol>
  );
}

/** The question and the answer as they are now, before either is a row anyone can read. */
function Live({ state }: { readonly state: Generation['state'] }) {
  if (state.phase === 'idle') return null;
  if (state.phase === 'failed') {
    return (
      <li>
        <Alert tone="negative">{state.message}</Alert>
      </li>
    );
  }
  if (state.phase === 'starting') {
    return (
      <>
        <Asked question={state.question} />
        <Said role="assistant">
          <Thinking />
        </Said>
      </>
    );
  }

  return (
    <>
      <Asked question={state.question} />
      <Said role="assistant">
        {state.phase === 'reconnecting' && <Reconnecting />}
        {state.view.parts.length === 0 && state.view.writingArgs === '' && <Thinking />}
        <Answer
          parts={state.view.parts}
          status="generating"
          live
          verification={state.view.verification}
          writingArgs={state.view.writingArgs}
          recheckAttempt={state.view.recheckAttempt}
        />
      </Said>
    </>
  );
}

/**
 * The question, while it is still only a question. Empty for an answer this page
 * is watching rather than one it asked, whose question is already in the
 * history above.
 */
function Asked({ question }: { readonly question: string }) {
  if (question === '') return null;

  return (
    <Said role="user">
      <p className="max-w-measure whitespace-pre-wrap">{question}</p>
    </Said>
  );
}

function Message({ message }: { readonly message: MessageView }) {
  return (
    <Said role={message.role}>
      {/* One message that will not draw must not take the conversation with it:
          `parts` is JSON from a column, so its shape is a claim rather than
          something the row can prove. */}
      <ErrorBoundary label="This message">
        {message.role === 'user' ? (
          <p className="max-w-measure whitespace-pre-wrap">{textOf(message)}</p>
        ) : (
          <Answer
            parts={message.parts}
            status={message.status}
            verification={message.verification}
          />
        )}
      </ErrorBoundary>
    </Said>
  );
}

function Said({
  role,
  children,
}: {
  readonly role: 'user' | 'assistant';
  readonly children: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2">
      <p className="font-mono text-micro tracking-wide text-muted uppercase">
        {role === 'user' ? 'You' : 'Assistant'}
      </p>
      {children}
    </li>
  );
}

function Thinking() {
  return (
    <p role="status" className="text-muted">
      Working on it…
    </p>
  );
}

/**
 * The connection went, not the answer. Saying which matters: an answer is being
 * written on the server throughout, and what is already on screen stays exactly
 * where it is.
 */
function Reconnecting() {
  return (
    <p
      role="status"
      className="mb-2 inline-flex items-center gap-2 font-mono text-micro tracking-wide text-muted uppercase"
    >
      <span aria-hidden="true" className="size-2 animate-pulse rounded-sm bg-warning" />
      Reconnecting
    </p>
  );
}

function textOf(message: MessageView): string {
  return message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('');
}

/** Anything closer to the bottom than this counts as being at the bottom. */
const AT_THE_END_PX = 80;
/** Less movement than this is a layout settling, not somebody scrolling. */
const A_DELIBERATE_SCROLL_PX = 8;

/**
 * A conversation opens at its end and stays there while an answer is written —
 * for as long as the reader is there too. Scrolling up to read an earlier answer
 * must not be undone every time a word lands, which is the difference between
 * following somebody and dragging them.
 *
 * Distance from the bottom is not enough to tell the two apart. Content arriving
 * grows the page without moving the scroll, so the distance widens on its own
 * and a reader who has not touched anything looks like one who has scrolled
 * away. What separates them is the direction: only a scroll that moves *up*
 * from where this last left it is somebody choosing to read back.
 */
interface Follows {
  readonly scroll: React.RefObject<HTMLDivElement | null>;
  readonly conversationId: string;
  /** How many messages the history holds, which grows when an answer is stored. */
  readonly at: number;
  readonly state: Generation['state'];
}

function useFollowsTheEnd({ scroll, conversationId, at, state }: Follows): void {
  const following = useRef(true);
  const followedAt = useRef(0);

  useEffect(() => {
    const box = scroll.current;
    if (box === null) return;

    const onScroll = (): void => {
      const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
      if (distance <= AT_THE_END_PX) following.current = true;
      else if (box.scrollTop < followedAt.current - A_DELIBERATE_SCROLL_PX) {
        following.current = false;
      }
    };
    box.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      box.removeEventListener('scroll', onScroll);
    };
  }, [scroll]);

  // A conversation just opened is always taken to its end, and reading it is
  // what decides whether it stays there.
  useEffect(() => {
    following.current = true;
  }, [conversationId]);

  useEffect(() => {
    const box = scroll.current;
    if (box === null || !following.current) return;

    box.scrollTo({ top: box.scrollHeight });
    // Where that leaves the scroll, not where it was asked to go: the browser
    // clamps it to the bottom, and this has to be comparable with a later
    // `scrollTop` to tell a reader moving up from a page growing taller.
    followedAt.current = box.scrollHeight - box.clientHeight;
  }, [scroll, conversationId, at, state]);
}

/**
 * The question the empty screen was asked, once. Guarded by a ref rather than by
 * a dependency list: effects run twice in development, and the same question
 * asked twice is two answers to it.
 */
function useAsksTheOpeningQuestion(opening: string | undefined, generation: Generation): void {
  const asked = useRef(false);

  useEffect(() => {
    if (opening === undefined || asked.current) return;

    asked.current = true;
    generation.send(opening);
  }, [opening, generation]);
}

/**
 * The answer that was being written when this page went away. Attaching to it
 * replays what it had written and then carries on live, so a refresh in the
 * middle of an answer costs nothing but the moment it takes to reconnect.
 */
function useResumeUnfinished(
  messages: readonly MessageView[],
  resume: (assistantMessageId: string) => void,
): void {
  const unfinished = messages.find(
    (message) => message.role === 'assistant' && message.status === 'generating',
  );

  useEffect(() => {
    if (unfinished !== undefined) resume(unfinished.id);
  }, [unfinished, resume]);
}

/**
 * The conversation was deleted — from another tab, or by the rail while this
 * page was open. Written as an effect rather than in the render, because
 * navigating during a render is a side effect in the middle of describing what
 * to draw.
 */
function useLeaveWhenGone(gone: boolean): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (gone) void navigate('/', { replace: true });
  }, [gone, navigate]);
}

interface UnreadableProps {
  readonly error: unknown;
  readonly onRetry: () => void;
}

function Unreadable({ error, onRetry }: UnreadableProps) {
  return (
    <div className="flex flex-col items-start gap-4">
      <Alert tone="negative">{messageFor(error)}</Alert>
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function Empty() {
  return <p className="text-muted">Ask the first question of this conversation.</p>;
}

function Loading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-8">
      {[0, 1].map((row) => (
        <div key={row} className="flex flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}
