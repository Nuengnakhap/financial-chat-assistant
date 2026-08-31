import { NavLink } from 'react-router';

import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { useSession, useSignOut } from '@/domains/auth';
import { messageFor } from '@/lib/api/errors';
import { cx } from '@/utils/cx';

/**
 * The rail beside the conversation: what you can start, what you have already
 * asked, and who you are. Starting and listing are both disabled here and say
 * why — a control that is present and refuses is honest, where one that is
 * present and silent is a bug the reader has to rule out.
 */
export function Sidebar() {
  const session = useSession();
  const signOut = useSignOut();
  const name = session.status === 'signed-in' ? session.user.displayName : '';

  return (
    <nav className="flex w-rail shrink-0 flex-col justify-between border-r border-line px-4 py-4">
      <div className="flex flex-col gap-4">
        <Button disabled title="Asking arrives with the conversation milestone">
          New chat
        </Button>
        <p className="font-mono text-micro tracking-wide text-muted uppercase">Conversations</p>
        <p className="text-body-sm text-muted">
          Nothing here yet. Asking arrives with the milestone after this one.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <p className="truncate text-body-sm">{name}</p>
        <NavLink
          to="/sessions"
          className={({ isActive }) =>
            cx('text-body-sm underline underline-offset-4', isActive ? 'text-text' : 'text-muted')
          }
        >
          Signed-in devices
        </NavLink>
        <Button
          size="sm"
          className="self-start"
          disabled={signOut.isPending}
          onClick={() => {
            signOut.mutate();
          }}
        >
          Sign out
        </Button>
        {signOut.isError && <Alert tone="negative">{messageFor(signOut.error)}</Alert>}
      </div>
    </nav>
  );
}
