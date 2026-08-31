import type { ConversationView } from '@fca/contracts';

import type { ConversationSummary } from '../application/ports/conversation.repository';

/**
 * The one place a stored conversation becomes what leaves over HTTP. A `Date`
 * is not a wire value: it becomes an ISO string here rather than wherever
 * `JSON.stringify` happens to reach it.
 */
export function toConversationView(conversation: ConversationSummary): ConversationView {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}
