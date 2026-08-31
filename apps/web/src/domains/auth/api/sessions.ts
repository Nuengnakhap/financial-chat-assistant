import type { SessionView } from '@fca/contracts';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { forgetSession } from './session';

import { api } from '@/lib/api/client';

const SESSIONS_KEY = ['auth', 'sessions'];

export const sessionsQuery = queryOptions({
  queryKey: SESSIONS_KEY,
  queryFn: async ({ signal }): Promise<readonly SessionView[]> => {
    const { sessions } = await api.auth.listSessions({ signal });
    return sessions;
  },
});

export function useRevokeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (session: SessionView) => {
      await api.auth.revokeSession({ params: { id: session.id } });
      return session;
    },
    onSuccess: async (session) => {
      // Revoking the session you are holding is a sign-out. The server clears
      // the cookies in that same answer, so leaving the screen up until the next
      // request fails would be waiting to be told something already known.
      if (session.current) {
        forgetSession(queryClient);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: async () => {
      // A row that is already gone answers 404. The list is what is out of date,
      // not the request, so the answer is to read it again rather than to retry.
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
}
