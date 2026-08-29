import { createHash } from 'node:crypto';

import type { Brand, ConversationId, MessageId, UserId } from '@fca/domain';

/**
 * A key that came from the registry below. Anything else is a string, and the
 * facade will not accept it — so no key format can be written at a call site.
 */
export type RedisKey = Brand<string, 'RedisKey'>;

// The single place allowed to mint one, mirroring how branded ids are made.
/* eslint-disable @typescript-eslint/consistent-type-assertions */
const key = (value: string): RedisKey => value as RedisKey;
/* eslint-enable @typescript-eslint/consistent-type-assertions */

/**
 * Every key the system uses, in one file. The `{...}` hash tag marks the part
 * that decides placement, so keys that must be operated on together stay
 * together if this ever runs on more than one node.
 */
export const K = {
  budget: (userId: UserId, windowStart: number): RedisKey =>
    key(`bgt:{${userId}}:${String(windowStart)}`),
  streamBuffer: (messageId: MessageId): RedisKey => key(`strm:{${messageId}}`),
  streamStop: (messageId: MessageId): RedisKey => key(`stop:{${messageId}}`),
  conversationLock: (conversationId: ConversationId): RedisKey =>
    key(`lock:conv:{${conversationId}}`),
  queryCache: (hash: string): RedisKey => key(`qc:${hash}`),
  /**
   * Hashed rather than raw: a key name is visible to anyone who can list the
   * keyspace, and the throttle only ever needs equality.
   */
  loginThrottle: (email: string): RedisKey =>
    key(
      `thr:login:e:{${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)}}`,
    ),
} as const;
