import type { MessagePart, MessageView } from '@fca/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';

import { messagesInOrder, messagesQuery } from '../api/messages';
import { useReachedEdge } from '../hooks/useReachedEdge';

import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/Skeleton';
import { ApiError, messageFor } from '@/lib/api/errors';

/** Everything said in one conversation, oldest first, with older pages above. */
export function MessageThread({ conversationId }: { readonly conversationId: string }) {
  const history = useInfiniteQuery(messagesQuery(conversationId));
  const sentinel = useReachedEdge(history.hasNextPage && !history.isFetchingNextPage, () => {
    void history.fetchNextPage();
  });
  const gone = history.isError && history.error instanceof ApiError && history.error.status === 404;
  useLeaveWhenGone(gone);
  const end = useOpenAtTheEnd(conversationId, history.isSuccess);

  if (history.isPending) return <Loading />;

  // A conversation that is not there any more is not an error to read: the
  // effect above is already taking the person back to where they can start
  // another one.
  if (history.isError) {
    return gone ? null : (
      <Unreadable
        error={history.error}
        onRetry={() => {
          void history.refetch();
        }}
      />
    );
  }

  const messages = messagesInOrder(history.data.pages);
  if (messages.length === 0) return <Empty />;

  return (
    <ol className="flex flex-col gap-8">
      {/* Above the oldest message, because that is the direction this list
          grows: reaching the top is what asks for what came before. */}
      <li ref={sentinel} aria-hidden="true">
        {history.isFetchingNextPage && <Skeleton className="h-4 w-24" />}
      </li>
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

/**
 * A conversation opens at its end. The list is drawn oldest first because that
 * is how a transcript reads, which puts the newest message below the fold of
 * anything longer than the screen — and the newest message is the one the
 * person was in the middle of.
 *
 * Only when the conversation changes, never when an older page arrives: loading
 * what came before must not throw the reader back to the bottom of it.
 */
function useOpenAtTheEnd(
  conversationId: string,
  ready: boolean,
): React.RefObject<HTMLLIElement | null> {
  const end = useRef<HTMLLIElement>(null);
  const landed = useRef('');

  useEffect(() => {
    if (!ready || landed.current === conversationId) return;

    landed.current = conversationId;
    end.current?.scrollIntoView({ block: 'end' });
  }, [conversationId, ready]);

  return end;
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
  return (
    <p className="text-muted">
      Nothing has been asked here yet. Asking arrives with the next milestone.
    </p>
  );
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

function Message({ message }: { readonly message: MessageView }) {
  return (
    <li className="flex flex-col gap-2">
      <p className="font-mono text-micro tracking-wide text-muted uppercase">
        {message.role === 'user' ? 'You' : 'Assistant'}
      </p>
      {message.parts.map((part, index) => (
        <Part key={`${message.id}-${String(index)}`} part={part} />
      ))}
    </li>
  );
}

/**
 * Only text renders today. A tool call and its result arrive with generation,
 * and a placeholder invented for them now would be a shape the real thing has
 * to match rather than one it chose.
 */
function Part({ part }: { readonly part: MessagePart }) {
  if (part.kind !== 'text') return null;

  return <p className="max-w-measure whitespace-pre-wrap">{part.text}</p>;
}
