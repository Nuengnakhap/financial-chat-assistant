/** The public surface. A deep import couples the caller to a file layout free to change. */

export {
  cursor,
  isoDateTime,
  microUsd,
  ok,
  page,
  paginationQuery,
  uuid,
  type Ok,
} from './primitives';

export {
  messageIdentity,
  messagePart,
  messageRole,
  messageStatus,
  toolResultRow,
  type MessagePart,
  type MessageRole,
  type MessageStatus,
  type ToolResultRow,
} from './domain-view/message-part';
export { CHART_BLOCK_SHAPE, chartSpec, type ChartSpec } from './domain-view/chart-spec';
export {
  claim,
  groundingReport,
  violation,
  type Claim,
  type GroundingReport,
  type Violation,
} from './domain-view/grounding-report';
export {
  conversationView,
  messageView,
  usageFacts,
  type ConversationView,
  type MessageView,
  type UsageFacts,
} from './domain-view/message';

export {
  TERMINAL_STREAM_EVENTS,
  budgetSnapshot,
  isTerminalStreamEvent,
  parseStreamEvent,
  remainingMicroUsd,
  streamEvent,
  type BudgetSnapshot,
  type StreamEvent,
  type StreamEventType,
} from './sse/stream-events.contract';

export { CSRF_HEADER, SESSION_COOKIE } from './http/session-cookies.contract';
export {
  apiErrorCode,
  apiFailure,
  type ApiErrorCode,
  type ApiFailure,
} from './http/failure.contract';
export {
  authContract,
  loginBody,
  registerBody,
  sessionView,
  userResponse,
  userView,
  type LoginBody,
  type RegisterBody,
  type SessionView,
  type UserView,
} from './http/auth.contract';
export {
  conversationResponse,
  conversationsContract,
  listConversationsQuery,
  listMessagesQuery,
  type ListConversationsQuery,
  type ListMessagesQuery,
} from './http/conversations.contract';
export {
  messagesContract,
  startGenerationBody,
  startGenerationResponse,
  type StartGenerationBody,
  type StartGenerationResponse,
} from './http/messages.contract';
export { usageContract, usageView, type UsageView } from './http/usage.contract';
