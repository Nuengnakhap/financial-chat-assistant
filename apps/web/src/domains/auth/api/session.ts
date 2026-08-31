import type { LoginBody, RegisterBody, UserView } from '@fca/contracts';
import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import { isUnauthenticated } from '@/lib/api/errors';

export type Session =
  { readonly status: 'signed-in'; readonly user: UserView } | { readonly status: 'signed-out' };

export const SESSION_KEY = ['session'];

export const sessionQuery = queryOptions({
  queryKey: SESSION_KEY,
  queryFn: async ({ signal }): Promise<Session> => {
    try {
      const { user } = await api.auth.me({ signal });
      return { status: 'signed-in', user };
    } catch (error) {
      // Being signed out is the answer to this question, so it is cached like
      // any other answer. Anything else is a real failure and stays one.
      if (isUnauthenticated(error)) return { status: 'signed-out' };
      throw error;
    }
  },
  // `apiFetch` already refreshed and retried once. Retrying on top of that would
  // hammer an endpoint that has just said no, including a rate-limited one.
  retry: false,
  staleTime: 30_000,
});

export function useSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: LoginBody) => await api.auth.login({ body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    },
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    // Registering signs the person in: the server sets the cookies with the 201.
    mutationFn: async (body: RegisterBody) => await api.auth.register({ body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    },
  });
}

/**
 * Everything that has to become true the moment a session ends, wherever it
 * ended from — signing out, or revoking the session you are holding. Both leave
 * the browser without cookies, so both have to leave the cache without an
 * answer that assumed them.
 */
export function forgetSession(queryClient: QueryClient): void {
  // Say what is now true rather than asking the server again: after a successful
  // sign-out the answer is known, and a round trip to hear it is a request
  // nobody needs.
  const signedOut: Session = { status: 'signed-out' };
  queryClient.setQueryData(SESSION_KEY, signedOut);
  // Then drop everything else. Whatever the previous person read is still in the
  // cache, and the next one on this machine would see it. `clear()` would do
  // that too, but it also detaches the screens watching the session, so they
  // keep showing the answer they were last given — measured: the chat screen
  // stayed up after a successful sign-out.
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== SESSION_KEY[0],
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => await api.auth.logout(),
    onSuccess: () => {
      forgetSession(queryClient);
    },
  });
}
