import type { ReactNode } from 'react';

import { Sidebar } from './Sidebar';

import { TopBar } from '@/components/TopBar';
import { BudgetBanner } from '@/domains/usage';

/**
 * The frame every signed-in screen sits in: the bar, the rail, and the room the
 * screen itself gets. Nothing here knows what the screen is.
 *
 * The banner is hung here rather than on the conversation because a spent
 * window is a fact about the person and not about the page they happen to be
 * on — and because the composer it stops is on more than one screen.
 */
export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-surface text-text">
      <TopBar />
      <BudgetBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
