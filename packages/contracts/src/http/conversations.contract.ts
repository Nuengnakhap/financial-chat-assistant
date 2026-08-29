import { z } from 'zod';

import { conversationView, messageView } from '../domain-view/message';
import { ok, page, paginationQuery } from '../primitives';

export const listConversationsQuery = paginationQuery(50);
export const listMessagesQuery = paginationQuery(100);

export const conversationResponse = z.object({ conversation: conversationView });

export const conversationsContract = {
  list: {
    method: 'GET',
    path: '/api/v1/conversations',
    status: 200,
    query: listConversationsQuery,
    response: page(conversationView),
  },
  create: {
    method: 'POST',
    path: '/api/v1/conversations',
    status: 201,
    body: z.object({}),
    response: conversationResponse,
  },
  get: {
    method: 'GET',
    path: '/api/v1/conversations/:id',
    status: 200,
    response: conversationResponse,
  },
  listMessages: {
    method: 'GET',
    path: '/api/v1/conversations/:id/messages',
    status: 200,
    query: listMessagesQuery,
    response: page(messageView),
  },
  /** The rows go through the delete pipeline, not inline — hence 202. */
  remove: { method: 'DELETE', path: '/api/v1/conversations/:id', status: 202, response: ok },
} as const;

export type ListConversationsQuery = z.infer<typeof listConversationsQuery>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuery>;
