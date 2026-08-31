import type { SessionView } from '@fca/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { sessionsQuery, useRevokeSession } from '../api/sessions';

import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/Skeleton';
import { messageFor } from '@/lib/api/errors';
import { formatWhen } from '@/utils/datetime';

/**
 * Every browser holding a session for this account. The list can never be
 * empty — whoever is reading it is on one of these rows — so there is no empty
 * state to write, only a loading one and a failure one.
 */
export function SessionList() {
  const { data, isPending, isError, error, refetch } = useQuery(sessionsQuery);

  if (isPending) return <Loading />;

  if (isError) {
    return (
      <div className="flex flex-col items-start gap-4">
        <Alert tone="negative">{messageFor(error)}</Alert>
        <Button
          size="sm"
          onClick={() => {
            void refetch();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <ul className="flex flex-col border-t border-line">
      {data.map((session) => (
        <SessionRow key={session.id} session={session} />
      ))}
    </ul>
  );
}

function Loading() {
  return (
    <ul aria-busy="true" className="flex flex-col border-t border-line">
      {[0, 1].map((row) => (
        <li key={row} className="flex flex-col gap-2 border-b border-line py-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-16" />
        </li>
      ))}
    </ul>
  );
}

function SessionRow({ session }: { readonly session: SessionView }) {
  return (
    <li className="flex items-center justify-between gap-4 border-b border-line py-4">
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-body-sm">
          {session.device}
          {session.current && (
            <span className="shrink-0 rounded-sm bg-verified-soft px-2 text-micro font-medium tracking-wide text-verified uppercase whitespace-nowrap">
              This device
            </span>
          )}
        </p>
        <p className="font-mono text-micro tracking-wide text-muted">
          {/* Eight characters is enough to tell two rows apart and not enough to
              follow anyone with. The hash is never shown in full. */}
          {formatWhen(session.lastUsedAt)} · {session.ipHash.slice(0, 8)}
        </p>
      </div>
      <RevokeControl session={session} />
    </li>
  );
}

function RevokeControl({ session }: { readonly session: SessionView }) {
  const [confirming, setConfirming] = useState(false);

  // Two clicks rather than a dialog: the row is already the thing being talked
  // about, so a box that repeats it back adds a sentence to read and a focus
  // trap to escape.
  //
  // One verb down the column, including the row you are reading on — a second
  // button called "Sign out" beside the one in the rail would be two controls
  // with one name doing different things. What that row costs is said at the
  // moment it is confirmed instead.
  if (!confirming) {
    return (
      <Button
        size="sm"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Revoke
      </Button>
    );
  }

  return (
    <ConfirmRevoke
      session={session}
      onCancel={() => {
        setConfirming(false);
      }}
    />
  );
}

interface ConfirmRevokeProps {
  readonly session: SessionView;
  readonly onCancel: () => void;
}

function ConfirmRevoke({ session, onCancel }: ConfirmRevokeProps) {
  const revoke = useRevokeSession();

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="text-body-sm text-muted">
          {session.current ? 'This signs you out here.' : 'Revoke this device?'}
        </span>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={revoke.isPending}
          onClick={() => {
            revoke.mutate(session);
          }}
        >
          Confirm
        </Button>
      </div>
      {revoke.isError && (
        // A row the server has already forgotten answers 404 and disappears on
        // the refetch, taking this with it. What survives is the failure worth
        // reading: one that left the row where it was.
        <p role="alert" className="text-body-sm text-negative">
          {messageFor(revoke.error)}
        </p>
      )}
    </div>
  );
}
