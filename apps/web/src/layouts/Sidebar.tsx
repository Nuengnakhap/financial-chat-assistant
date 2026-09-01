import { NavLink, useNavigate } from 'react-router';

import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { useSession, useSignOut } from '@/domains/auth';
import { ConversationList, useCreateConversation } from '@/domains/conversation';
import { messageFor } from '@/lib/api/errors';
import { cx } from '@/utils/cx';

/**
 * The rail beside the conversation: what you can start, what you have already
 * asked, and who you are.
 */
export function Sidebar() {
  const session = useSession();
  const signOut = useSignOut();
  const name = session.status === 'signed-in' ? session.user.displayName : '';

  return (
    <nav className="flex w-rail shrink-0 flex-col justify-between border-r border-line px-4 py-4">
      <div className="flex min-h-0 flex-col gap-4">
        <NewChat />
        <p className="font-mono text-micro tracking-wide text-muted uppercase">Conversations</p>
        <ConversationList />
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

/**
 * Starting one and opening it are the same act, so the button does both — a new
 * conversation left in the rail for someone to find would be a second step for
 * no reason. The failure stays under the button: there is nowhere else to go.
 */
function NewChat() {
  const create = useCreateConversation();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-2">
      <Button
        disabled={create.isPending}
        onClick={() => {
          create.mutate(undefined, {
            onSuccess: (conversation) => {
              void navigate(`/c/${conversation.id}`);
            },
          });
        }}
      >
        New chat
      </Button>
      {create.isError && <Alert tone="negative">{messageFor(create.error)}</Alert>}
    </div>
  );
}
