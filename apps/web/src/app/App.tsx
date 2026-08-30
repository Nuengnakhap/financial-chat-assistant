import { useEffect, useState } from 'react';

import { ThemeToggle } from '../features/theme-toggle/ThemeToggle';
import { checkApiHealth, type ApiHealth } from '../shared/api/health';
import { Alert, type AlertTone } from '../shared/ui/Alert';

const STATUS: Record<ApiHealth, { readonly tone: AlertTone; readonly text: string }> = {
  checking: { tone: 'info', text: 'Checking the API…' },
  ready: { tone: 'positive', text: 'API reachable' },
  // A warning rather than an error: nothing the person did has failed, the
  // backend simply is not running. That also keeps this a polite `status`
  // region instead of something that interrupts a screen reader.
  unreachable: { tone: 'warning', text: 'API unreachable — start it with pnpm dev' },
};

export function App() {
  const [health, setHealth] = useState<ApiHealth>('checking');

  useEffect(() => {
    const abort = new AbortController();
    const run = async (): Promise<void> => {
      const result = await checkApiHealth(abort.signal);
      if (!abort.signal.aborted) setHealth(result);
    };
    void run();
    return () => {
      abort.abort();
    };
  }, []);

  const status = STATUS[health];

  return (
    // Edge to edge. An application fills its window; a rounded card floating on
    // grey is how a screenshot is presented, not how one is built.
    <div className="flex h-screen flex-col bg-surface text-text">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-6">
        <p className="text-body-sm font-medium">Financial Chat Assistant</p>
        <ThemeToggle />
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
        <h1 className="text-display font-semibold tracking-tight">
          Ask about the revenue and income of U.S. public companies.
        </h1>
        <p className="text-muted">
          Sign-in and the chat surface arrive with the milestones after this one.
        </p>
        <Alert tone={status.tone}>{status.text}</Alert>
      </main>
    </div>
  );
}
