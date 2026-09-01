import type { MessageView } from '@fca/contracts';
import { infiniteQueryOptions } from '@tanstack/react-query';

import { api } from '@/lib/api/client';

/** Enough that a conversation of ordinary length arrives whole. */
const PAGE_SIZE = 100;

/** Opaque to everything here: the server made it and only the server reads it. */
type Cursor = string | null;

/** Named so the type of a page parameter is stated rather than asserted into place. */
const FIRST_PAGE: Cursor = null;

interface Page {
  readonly items: readonly MessageView[];
  readonly nextCursor: string | null;
}

/**
 * A conversation is read from its end: the first page is the newest messages,
 * and each page after it is older. React Query keeps pages in the order they
 * were fetched, so `messagesInOrder` is what turns that back into a transcript.
 */
export const messagesQuery = (conversationId: string) =>
  infiniteQueryOptions({
    queryKey: ['conversations', conversationId, 'messages'],
    queryFn: async ({ pageParam, signal }): Promise<Page> =>
      await api.conversations.listMessages({
        params: { id: conversationId },
        // `null` on the first page, which the client leaves out of the URL.
        query: { limit: PAGE_SIZE, cursor: pageParam },
        signal,
      }),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (page: Page) => page.nextCursor,
  });

/**
 * Oldest first. The pages arrive newest-chunk first and each page is already in
 * reading order inside itself, so the chunks are reversed and the items are not.
 */
export function messagesInOrder(pages: readonly Page[]): readonly MessageView[] {
  return [...pages].reverse().flatMap((page) => page.items);
}
