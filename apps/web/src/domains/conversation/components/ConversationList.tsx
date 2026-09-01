import type { ConversationView } from '@fca/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, useMatch, useNavigate, useParams } from 'react-router';

import { conversationsQuery, useRemoveConversation } from '../api/conversations';
import { useReachedEdge } from '../hooks/useReachedEdge';

import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Menu, type MenuItem } from '@/components/Menu';
import { Modal } from '@/components/Modal';
import { Skeleton } from '@/components/Skeleton';
import { messageFor } from '@/lib/api/errors';
import { cx } from '@/utils/cx';

/** What the rail shows: every conversation, newest first, and a way out of each. */
export function ConversationList() {
  const rail = useInfiniteQuery(conversationsQuery);
  const deletion = useDeleteConversation();
  // The question lives here rather than in the row, because confirming it is
  // what removes the row: a modal owned by the row would go with it, mid-answer.
  const [pending, setPending] = useState<ConversationView | null>(null);

  if (rail.isPending) return <Loading />;
  if (rail.isError) return <Unreadable error={rail.error} refetch={rail.refetch} />;

  const conversations = rail.data.pages.flatMap((page) => page.items);
  if (conversations.length === 0) {
    return <p className="text-body-sm text-muted">No conversations yet.</p>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Rows
        conversations={conversations}
        onDelete={setPending}
        more={rail.hasNextPage && !rail.isFetchingNextPage}
        loading={rail.isFetchingNextPage}
        onReachEnd={() => {
          void rail.fetchNextPage();
        }}
      />
      <DeletionFailure failure={deletion.failure} />
      <ConfirmDelete
        conversation={pending}
        onClose={() => {
          setPending(null);
        }}
        onConfirm={deletion.remove}
      />
    </div>
  );
}

interface ConfirmDeleteProps {
  readonly conversation: ConversationView | null;
  readonly onClose: () => void;
  readonly onConfirm: (conversation: ConversationView) => void;
}

/**
 * What it costs, said at the moment it is being agreed to rather than in the
 * label of the thing that opens it — the same reason ending a session says so on
 * its confirming step.
 */
function ConfirmDelete({ conversation, onClose, onConfirm }: ConfirmDeleteProps) {
  return (
    <Modal open={conversation !== null} title="Delete this conversation?" onClose={onClose}>
      <p className="text-muted">
        {conversation === null
          ? ''
          : `“${conversation.title}” and every message in it will be removed. This cannot be undone.`}
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          onClick={() => {
            if (conversation !== null) onConfirm(conversation);
            onClose();
          }}
        >
          Delete
        </Button>
      </div>
    </Modal>
  );
}

interface RowsProps {
  readonly conversations: readonly ConversationView[];
  readonly onDelete: (conversation: ConversationView) => void;
  /** Whether there is another page and nothing is already fetching it. */
  readonly more: boolean;
  readonly loading: boolean;
  readonly onReachEnd: () => void;
}

function Rows({ conversations, onDelete, more, loading, onReachEnd }: RowsProps) {
  const sentinel = useReachedEdge(more, onReachEnd);

  return (
    <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
      {conversations.map((conversation) => (
        <ConversationRow key={conversation.id} conversation={conversation} onDelete={onDelete} />
      ))}
      {/* Loading the next page replaces nothing: what is already readable stays
          readable, and a row appears under it while more arrives. */}
      <li ref={sentinel} aria-hidden="true">
        {loading && <Skeleton className="h-6 w-full" />}
      </li>
    </ul>
  );
}

interface Deletion {
  readonly remove: (conversation: ConversationView) => void;
  /** The failure to show, or nothing. `unknown` because a rejection can be anything. */
  readonly failure: unknown;
}

/**
 * Deleting belongs to the list rather than to the row, because the row is what
 * the deletion removes: taken out of the rail the moment it is confirmed, the
 * row unmounts, and a callback passed to `mutate` from inside it is then never
 * called — which is how the page showing that conversation was left sitting
 * there after the conversation had gone. The list outlives the row, so it is
 * where both the leaving and the failure can be seen.
 */
function useDeleteConversation(): Deletion {
  const remove = useRemoveConversation();
  const navigate = useNavigate();
  const { id } = useParams();

  return {
    remove: (conversation) => {
      remove.mutate(conversation.id);
      // Optimistic, like the row: the conversation is gone from every read as
      // of the 202, so a page still showing it is showing something untrue.
      if (id === conversation.id) void navigate('/', { replace: true });
    },
    failure: remove.isError ? remove.error : null,
  };
}

/** Under the list rather than in a row, because the row it belonged to is gone. */
function DeletionFailure({ failure }: { readonly failure: unknown }) {
  if (failure === null) return null;

  return (
    <p role="alert" className="text-body-sm text-negative">
      {messageFor(failure)}
    </p>
  );
}

function Loading() {
  return (
    <ul aria-busy="true" className="flex flex-col gap-1">
      {[0, 1, 2].map((row) => (
        <li key={row} className="py-2">
          <Skeleton className="h-4 w-full" />
        </li>
      ))}
    </ul>
  );
}

interface UnreadableProps {
  readonly error: unknown;
  readonly refetch: () => Promise<unknown>;
}

function Unreadable({ error, refetch }: UnreadableProps) {
  return (
    <div className="flex flex-col items-start gap-2">
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

interface RowProps {
  readonly conversation: ConversationView;
  readonly onDelete: (conversation: ConversationView) => void;
}

function ConversationRow({ conversation, onDelete }: RowProps) {
  // Named rather than written inline, so the second action is a line added to a
  // list rather than a row rewritten around it.
  const actions: readonly MenuItem[] = [
    {
      label: 'Delete',
      tone: 'negative',
      onSelect: () => {
        onDelete(conversation);
      },
    },
  ];

  return (
    // The highlight belongs to the row, not to the link inside it: on the link
    // it stopped where the link stopped, leaving the menu button sitting in a
    // notch of bare rail. `group` is also what lets the row's hover reveal that
    // button.
    <li
      className={cx(
        'group flex items-center rounded-md',
        useMatch(`/c/${conversation.id}`) === null ? 'hover:bg-raised' : 'bg-raised',
      )}
    >
      <RowLink conversation={conversation} />
      <Menu
        label={`More actions for ${conversation.title}`}
        // Revealed on hover, and on focus as well: `opacity-0` keeps its place
        // in the row and stays reachable by Tab, where `hidden` would put it out
        // of a keyboard's reach entirely.
        className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
        items={actions}
      />
    </li>
  );
}

/**
 * The padding stays here rather than moving to the row, so what navigates is
 * still the whole left of the row rather than a band inside a padded one.
 */
function RowLink({ conversation }: { readonly conversation: ConversationView }) {
  return (
    <NavLink
      to={`/c/${conversation.id}`}
      className={({ isActive }) =>
        cx(
          'min-w-0 flex-1 px-2 py-2 text-body-sm',
          isActive ? 'text-text' : 'text-muted group-hover:text-text',
        )
      }
    >
      {/* Clamped on an element of its own, because `line-clamp` hides what
          overflows the padding box rather than the content box: with the padding
          on the same element a third line shows through the bottom of it, cut in
          half. Two lines is what 256px of rail was chosen for, and what a title
          is cut to sixty characters to fit. */}
      <span className="line-clamp-2">{conversation.title}</span>
    </NavLink>
  );
}
