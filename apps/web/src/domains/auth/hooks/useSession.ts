import { useQuery } from '@tanstack/react-query';

import { sessionQuery, type Session } from '../api/session';

import { messageFor } from '@/lib/api/errors';

export type SessionState =
  | { readonly status: 'checking' }
  | Session
  | { readonly status: 'unavailable'; readonly message: string };

/**
 * The whole of "who is signed in" for the application. There is no effect, no
 * AbortController and no race to guard against: the query carries its own
 * signal and discards the answer of a request it has superseded, and every
 * caller reads the same cached result rather than issuing its own.
 */
export function useSession(): SessionState {
  const { data, error, isPending } = useQuery(sessionQuery);

  if (data !== undefined) return data;
  if (isPending) return { status: 'checking' };
  return { status: 'unavailable', message: messageFor(error) };
}
