import { useParams } from 'react-router';

import { MessageThread } from '@/domains/conversation';
import { AppShell } from '@/layouts/AppShell';

/**
 * One screen for both: with no conversation open it says what this can answer,
 * and with one open it is that conversation. The composer is the same either
 * way, because where a question goes does not depend on whether anything has
 * been asked yet.
 */
export function ChatPage() {
  const { id } = useParams();

  return (
    <AppShell>
      <div className="flex min-h-0 flex-1 flex-col justify-between px-24 py-16">
        <div className="min-h-0 w-full max-w-measure overflow-y-auto">
          {id === undefined ? <Welcome /> : <MessageThread conversationId={id} />}
        </div>
        <Composer />
      </div>
    </AppShell>
  );
}

function Welcome() {
  return (
    <>
      <h1 className="text-display font-book tracking-tight">
        Ask about the revenue and income of U.S. public companies.
      </h1>
      <p className="mt-4 text-muted">
        Every figure in an answer comes from a query you can read, and is checked against that
        query&rsquo;s result before it reaches you.
      </p>
    </>
  );
}

/**
 * Present and refusing, rather than absent. Someone looking at this screen can
 * see where a question goes and read why it will not go yet; a composer that
 * was simply missing would leave them wondering whether it failed to load.
 *
 * There are no example questions under it. They would have to come from the
 * catalogue of what the dataset can answer, which does not exist yet, and
 * inventing three is how a demo ends up promising something it cannot do.
 */
function Composer() {
  return (
    <div className="w-full max-w-measure pt-8">
      <div className="flex items-center gap-3 border-t border-line-strong pt-3">
        <input
          disabled
          aria-label="Ask a question"
          placeholder="Asking arrives with the next milestone"
          className="min-w-0 flex-1 bg-surface text-body text-text placeholder:text-muted"
        />
      </div>
      <p className="mt-3 font-mono text-micro tracking-wide text-muted uppercase">
        Every figure is verified against the query result
      </p>
    </div>
  );
}
