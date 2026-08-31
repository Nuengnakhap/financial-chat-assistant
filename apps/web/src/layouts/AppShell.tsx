import type { ReactNode } from 'react';

import { Sidebar } from './Sidebar';

import { TopBar } from '@/components/TopBar';

/**
 * The frame every signed-in screen sits in: the bar, the rail, and the room the
 * screen itself gets. Nothing here knows what the screen is.
 */
export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-surface text-text">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
