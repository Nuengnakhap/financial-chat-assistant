import { SessionList } from '@/domains/auth';
import { AppShell } from '@/layouts/AppShell';

export function SessionsPage() {
  return (
    <AppShell>
      <div className="flex flex-col px-24 py-16">
        <div className="w-full max-w-measure">
          <h1 className="text-display font-book tracking-tight">Signed-in devices</h1>
          <p className="mt-4 text-muted">
            Every browser holding a session for this account. Revoking one signs it out at once.
          </p>
          <div className="mt-10">
            <SessionList />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
