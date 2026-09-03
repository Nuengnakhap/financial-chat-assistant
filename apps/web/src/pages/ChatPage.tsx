import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';

import { EXAMPLES } from './examples';

import { Button } from '@/components/Button';
import { ChatRoom, useCreateConversation } from '@/domains/conversation';
import { AppShell } from '@/layouts/AppShell';

/**
 * One screen for both: with no conversation open it says what this can answer,
 * and with one open it is that conversation. Asking from the empty screen makes
 * the conversation first and then asks in it, so a question is never typed into
 * somewhere it cannot be kept.
 */
export function ChatPage() {
  const { id } = useParams();
  const opening = useOpeningQuestion();

  return (
    <AppShell>
      <div className="flex min-h-0 flex-1 flex-col justify-between px-6 py-16 md:px-12 lg:px-24">
        {id === undefined ? (
          <Welcome />
        ) : (
          <ChatRoom key={id} conversationId={id} opening={opening} />
        )}
      </div>
    </AppShell>
  );
}

/**
 * Whatever the empty screen was asked, if this room was opened from it — read
 * once and then taken out of the history.
 *
 * `navigate` with state writes to `history.state`, and `history.state` survives
 * a reload. Left there, refreshing a page mid-answer would ask the same question
 * a second time: measured in a real browser, which is the only place a reload
 * exists.
 */
function useOpeningQuestion(): string | undefined {
  const location = useLocation();
  const navigate = useNavigate();
  const question = openingQuestion(location.state);
  const { pathname } = location;

  useEffect(() => {
    if (question !== undefined) void navigate(pathname, { replace: true });
  }, [question, pathname, navigate]);

  return question;
}

function openingQuestion(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('question' in state)) return undefined;

  return typeof state.question === 'string' ? state.question : undefined;
}

function Welcome() {
  const create = useCreateConversation();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);

  const ask = (question: string): void => {
    if (asking) return;
    setAsking(true);

    create.mutate(undefined, {
      onSuccess: (conversation) => {
        // Carried in the route rather than in a store: the room is about to
        // mount for the first time, and this is the one thing it needs to know
        // that its own id does not tell it.
        void navigate(`/c/${conversation.id}`, { state: { question } });
      },
      onError: () => {
        setAsking(false);
      },
    });
  };

  return (
    <>
      <div className="mx-auto w-full max-w-room px-6">
        <h1 className="max-w-measure text-display font-book tracking-tight">
          Ask about the revenue and income of U.S. public companies.
        </h1>
        <p className="mt-4 max-w-measure text-muted">
          Every figure in an answer comes from a query you can read, and is checked against that
          query&rsquo;s result before it reaches you.
        </p>
        <Examples disabled={asking} onPick={ask} />
      </div>
      <div className="mx-auto w-full max-w-room px-6">
        <p className="border-t border-line-strong pt-3 font-mono text-micro tracking-wide text-muted uppercase">
          Every figure is verified against the query result
        </p>
      </div>
    </>
  );
}

interface ExamplesProps {
  readonly disabled: boolean;
  readonly onPick: (question: string) => void;
}

function Examples({ disabled, onPick }: ExamplesProps) {
  return (
    <ul className="mt-8 flex flex-col items-start gap-2">
      {EXAMPLES.map(({ question }) => (
        <li key={question}>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              onPick(question);
            }}
          >
            {question}
          </Button>
        </li>
      ))}
    </ul>
  );
}
