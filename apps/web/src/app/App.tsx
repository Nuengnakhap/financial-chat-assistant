import { useEffect, useState } from 'react';

import { checkApiHealth, type ApiHealth } from '../shared/api/health';

const STATUS_TEXT: Record<ApiHealth, string> = {
  checking: 'Checking the API…',
  ready: 'API reachable',
  unreachable: 'API unreachable — start it with pnpm dev',
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

  return (
    <main>
      <h1>Financial Chat Assistant</h1>
      <p>Ask about the revenue and income of U.S. public companies.</p>
      <p role="status">{STATUS_TEXT[health]}</p>
    </main>
  );
}
