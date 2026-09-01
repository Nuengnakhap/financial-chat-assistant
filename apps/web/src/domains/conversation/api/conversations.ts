import type { ConversationView } from '@fca/contracts';
import {
  infiniteQueryOptions,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';

import { api } from '@/lib/api/client';

/**
 * `exact` accompanies every invalidation of this key, and is not a detail: a
 * conversation's history is keyed `['conversations', id, 'messages']`, so a
 * prefix match would re-read every open thread as well — including the one
 * belonging to the conversation just deleted, which then asks the server for
 * something it has already removed and is answered 404.
 */
const RAIL_KEY = ['conversations'];

/** The most the contract allows in one page, so the rail asks once and usually stops. */
const PAGE_SIZE = 50;

/** Opaque to everything here: the server made it and only the server reads it. */
type Cursor = string | null;

/** Named so the type of a page parameter is stated rather than asserted into place. */
const FIRST_PAGE: Cursor = null;

interface Page {
  readonly items: readonly ConversationView[];
  readonly nextCursor: string | null;
}

/**
 * The rail, page by page. `pageParam` is the opaque cursor the server handed
 * back, and `null` on the first call — asking for a page with no cursor is what
 * "start at the top" means, rather than a separate call.
 */
export const conversationsQuery = infiniteQueryOptions({
  queryKey: RAIL_KEY,
  queryFn: async ({ pageParam, signal }): Promise<Page> =>
    await api.conversations.list({
      // `null` on the first page, which the client leaves out of the URL.
      query: { limit: PAGE_SIZE, cursor: pageParam },
      signal,
    }),
  initialPageParam: FIRST_PAGE,
  getNextPageParam: (page: Page) => page.nextCursor,
});

export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<ConversationView> => {
      const { conversation } = await api.conversations.create();

      return conversation;
    },
    // The caller opens the conversation with what came back; the rail reads
    // itself again because it is a list, and the new one belongs at the top of
    // it in whatever order the server keeps.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: RAIL_KEY, exact: true });
    },
  });
}

export function useRemoveConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await api.conversations.remove({ params: { id } });
    },
    // Taken out of the rail before the server answers, because the answer is
    // 202: the conversation is already gone from every read by the time it
    // arrives, and leaving the row up until then would show something untrue.
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: RAIL_KEY, exact: true });
      const previous = queryClient.getQueryData(conversationsQuery.queryKey);
      queryClient.setQueryData(conversationsQuery.queryKey, (rail) =>
        rail === undefined ? rail : withoutConversation(rail, id),
      );

      return { previous };
    },
    onError: (_error, _id, context) => {
      // Put it back. A row that vanished and a request that failed would
      // otherwise leave the person believing something was deleted.
      if (context?.previous !== undefined) {
        queryClient.setQueryData(conversationsQuery.queryKey, context.previous);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: RAIL_KEY, exact: true });
    },
  });
}

/**
 * The page parameter is `unknown` here on purpose: that is what React Query's
 * own tag on `queryKey` carries, and matching it is what lets the cache be read
 * and written without an assertion in between.
 */
type Rail = InfiniteData<Page>;

function withoutConversation(rail: Rail, id: string): Rail {
  return {
    ...rail,
    pages: rail.pages.map((page) => ({
      ...page,
      items: page.items.filter((conversation) => conversation.id !== id),
    })),
  };
}
