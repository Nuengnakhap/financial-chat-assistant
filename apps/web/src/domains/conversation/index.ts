/**
 * The only way into this domain. Everything below is internal: renaming a file
 * inside `api/`, `hooks/` or `components/` must not reach another domain, and a
 * deep import is what makes that impossible. `.dependency-cruiser.cjs` enforces
 * it rather than trusting the convention.
 */
export { ConversationList } from './components/ConversationList';
export { ChatRoom } from './components/ChatRoom';
export { useCreateConversation } from './api/conversations';
