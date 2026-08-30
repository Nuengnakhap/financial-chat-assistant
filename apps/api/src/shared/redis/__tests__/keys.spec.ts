import { ConversationId, MessageId, UserId } from '@fca/domain';
import { describe, expect, it } from 'vitest';

import { K } from '../keys';

const userId = UserId.trusted('11111111-1111-4111-8111-111111111111');
const messageId = MessageId.trusted('22222222-2222-4222-8222-222222222222');
const conversationId = ConversationId.trusted('33333333-3333-4333-8333-333333333333');

describe('key registry', () => {
  it('gives every key a namespace of its own', () => {
    expect(K.budget(userId, 1_700_000_000)).toBe(
      'bgt:{11111111-1111-4111-8111-111111111111}:1700000000',
    );
    expect(K.streamBuffer(messageId)).toBe('strm:{22222222-2222-4222-8222-222222222222}');
    expect(K.streamStop(messageId)).toBe('stop:{22222222-2222-4222-8222-222222222222}');
    expect(K.conversationLock(conversationId)).toBe(
      'lock:conv:{33333333-3333-4333-8333-333333333333}',
    );
    expect(K.queryCache('abc123')).toBe('qc:abc123');
  });

  it('places the stream buffer and its stop flag on the same hash slot', () => {
    // A stop that lands on another node cannot be read by the loop it stops.
    const tag = (key: string): string => key.slice(key.indexOf('{'), key.indexOf('}') + 1);

    expect(tag(K.streamStop(messageId))).toBe(tag(K.streamBuffer(messageId)));
  });

  it('keeps the address out of the throttle key', () => {
    const key = K.authThrottleEmail('Someone@Example.com');

    expect(key).not.toContain('Someone');
    expect(key).not.toContain('example.com');
    expect(key).toMatch(/^thr:auth:e:\{[0-9a-f]{32}\}$/);
  });

  it('throttles an address the same way however it was typed', () => {
    expect(K.authThrottleEmail('  Someone@Example.com ')).toBe(
      K.authThrottleEmail('someone@example.com'),
    );
  });

  it('counts signing in and registering under separate keys', () => {
    const ipHash = 'f'.repeat(64);

    // Sharing one key would let a burst of registrations lock a host out of
    // signing in, which is the opposite of what the limit is for.
    expect(K.registrationThrottleIp(ipHash)).not.toBe(K.authThrottleIp(ipHash));
  });
});
