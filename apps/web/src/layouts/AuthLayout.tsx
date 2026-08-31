import type { ReactNode } from 'react';

import { TopBar } from '@/components/TopBar';

interface AuthLayoutProps {
  readonly title: string;
  /** One sentence saying what the product is, for someone who arrived cold. */
  readonly subtitle: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}

/**
 * The one screen shape both sign-in and registration use. The column sits at a
 * margin rather than in the middle of the window: a form centred in a page of
 * white has nothing holding it, and the left edge gives the eye a line to start
 * from — the same line the heading, the fields and the button all share.
 */
export function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col bg-surface text-text">
      <TopBar />
      <main className="flex flex-1 flex-col px-24 pt-24">
        <div className="w-full max-w-form">
          <h1 className="text-display font-book tracking-tight">{title}</h1>
          <p className="mt-3 text-muted">{subtitle}</p>
          <div className="mt-10">{children}</div>
          <p className="mt-8 text-body-sm text-muted">{footer}</p>
        </div>
      </main>
    </div>
  );
}
