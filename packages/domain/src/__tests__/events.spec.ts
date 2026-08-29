import { describe, expect, it } from 'vitest';

import { DOMAIN_EVENT_TYPES, isDomainEventType } from '../events';

describe('the event vocabulary', () => {
  it('names every event a consumer may be handed', () => {
    expect(DOMAIN_EVENT_TYPES).toContain('generation.requested');
    expect(DOMAIN_EVENT_TYPES).toContain('usage.recorded');
    expect(new Set(DOMAIN_EVENT_TYPES).size).toBe(DOMAIN_EVENT_TYPES.length);
  });

  it('scopes every type to the context that raises it', () => {
    // A bare "created" would collide the moment a second aggregate has one.
    for (const type of DOMAIN_EVENT_TYPES) {
      expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});

describe('recognising a type read back from storage', () => {
  it.each(DOMAIN_EVENT_TYPES)('accepts %s', (type) => {
    expect(isDomainEventType(type)).toBe(true);
  });

  it.each(['conversation.deleted', 'Conversation.Created', '', 'generation'])(
    'rejects %o, which no consumer knows how to handle',
    (type) => {
      // The outbox column is text, so a row written by an older or newer
      // version can carry anything; the guard is what stops it being trusted.
      expect(isDomainEventType(type)).toBe(false);
    },
  );
});
