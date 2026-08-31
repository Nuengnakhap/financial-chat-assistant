import { Navigate, Outlet } from 'react-router';

import { Alert } from '@/components/Alert';
import { Skeleton } from '@/components/Skeleton';
import { useSession } from '@/domains/auth';

/** Shown while the first `/auth/me` is in flight, so nothing decides too early. */
function Waiting() {
  return (
    <div className="flex h-screen flex-col gap-4 p-6">
      <Skeleton className="h-4 w-12" />
      <Skeleton className="h-4 w-8" />
    </div>
  );
}

function Unavailable({ message }: { readonly message: string }) {
  return (
    <div className="p-6">
      <Alert tone="warning" title="Cannot check your session">
        {message}
      </Alert>
    </div>
  );
}

/**
 * Layout routes rather than wrappers around each element: a second protected
 * screen is one more `<Route>` inside, not another copy of this decision.
 *
 * Redirecting before the answer arrives is what produces the flash of a sign-in
 * screen for somebody who is already signed in, so `checking` renders and waits.
 */
export function Protected() {
  const session = useSession();

  if (session.status === 'checking') return <Waiting />;
  if (session.status === 'unavailable') return <Unavailable message={session.message} />;
  if (session.status === 'signed-out') return <Navigate to="/login" replace />;
  return <Outlet />;
}

export function GuestOnly() {
  const session = useSession();

  if (session.status === 'checking') return <Waiting />;
  if (session.status === 'signed-in') return <Navigate to="/" replace />;
  return <Outlet />;
}
