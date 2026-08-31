import { Providers } from './providers';

import { Router } from '@/routes/router';

export function App() {
  return (
    <Providers>
      <Router />
    </Providers>
  );
}
