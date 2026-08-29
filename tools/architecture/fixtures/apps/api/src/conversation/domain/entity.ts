// Violates layer-domain-inward: a business rule reaching for the adapter that
// happens to store it, which makes the rule impossible to test without one.
import { findConversation } from '../infrastructure/repo';

export const title = (): string => findConversation();
