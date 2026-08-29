import { describe, expect, it } from 'vitest';

import { authContract } from '../auth.contract';
import { conversationsContract } from '../conversations.contract';
import { messagesContract, startGenerationBody } from '../messages.contract';
import { usageContract } from '../usage.contract';

const ALL_ROUTES = [
  ...Object.values(authContract),
  ...Object.values(conversationsContract),
  ...Object.values(messagesContract),
  ...Object.values(usageContract),
];

describe('every route', () => {
  it('is versioned from the first release', () => {
    // Adding /v2 later is cheap; adding a version to an unversioned API is not.
    for (const route of ALL_ROUTES) {
      expect(route.path).toMatch(/^\/api\/v1\//);
    }
  });

  it('uses a method that matches its effect', () => {
    for (const route of ALL_ROUTES) {
      expect(['GET', 'POST', 'DELETE']).toContain(route.method);
    }
  });

  it('has a unique method and path', () => {
    const keys = ALL_ROUTES.map((route) => `${route.method} ${route.path}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares the status it answers with, rather than describing it in prose', () => {
    for (const route of ALL_ROUTES) {
      expect([200, 201, 202]).toContain(route.status);
    }
  });

  it('answers 202 exactly where the work outlives the response', () => {
    // Deleting a conversation runs a pipeline; starting or stopping a generation
    // hands off to a runner. Anything else has finished by the time it replies.
    const accepted = ALL_ROUTES.filter((route) => route.status === 202).map((route) => route.path);

    expect(new Set(accepted)).toEqual(
      new Set([
        '/api/v1/conversations/:id',
        '/api/v1/conversations/:id/messages',
        '/api/v1/messages/:id/stop',
      ]),
    );
  });
});

describe('starting a generation', () => {
  const valid = {
    content: 'What was Apple revenue in 2024?',
    clientMessageId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  };

  it('accepts a question within the length budget', () => {
    expect(startGenerationBody.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty question', () => {
    expect(startGenerationBody.safeParse({ ...valid, content: '' }).success).toBe(false);
  });

  it('rejects a question long enough to blow the prompt budget', () => {
    expect(startGenerationBody.safeParse({ ...valid, content: 'x'.repeat(4_001) }).success).toBe(
      false,
    );
  });

  it('requires the idempotency key, without which a retry duplicates the message', () => {
    const { clientMessageId: _omitted, ...withoutKey } = valid;

    expect(startGenerationBody.safeParse(withoutKey).success).toBe(false);
    expect(startGenerationBody.safeParse({ ...valid, clientMessageId: 'not-a-uuid' }).success).toBe(
      false,
    );
  });

  it('drops unknown fields rather than passing them through to a handler', () => {
    const parsed = startGenerationBody.parse({ ...valid, isAdmin: true });

    expect(parsed).not.toHaveProperty('isAdmin');
  });
});

describe('pagination', () => {
  it('caps each list at the limit its plan sets', () => {
    expect(conversationsContract.list.query.safeParse({ limit: '51' }).success).toBe(false);
    expect(conversationsContract.listMessages.query.safeParse({ limit: '101' }).success).toBe(
      false,
    );
    expect(conversationsContract.listMessages.query.safeParse({ limit: '100' }).success).toBe(true);
  });

  it('defaults to the maximum when a limit is not given', () => {
    expect(conversationsContract.list.query.parse({}).limit).toBe(50);
  });

  it('reads a limit from the query string, which is always text', () => {
    expect(conversationsContract.list.query.parse({ limit: '10' }).limit).toBe(10);
  });
});

describe('credentials', () => {
  const valid = { email: 'user@example.com', password: 'correct-horse-battery' };

  it('rejects a password short enough to guess', () => {
    expect(authContract.login.body.safeParse({ ...valid, password: 'short' }).success).toBe(false);
  });

  it('rejects a password long enough to make hashing a denial of service', () => {
    expect(authContract.login.body.safeParse({ ...valid, password: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('rejects a malformed email', () => {
    expect(authContract.login.body.safeParse({ ...valid, email: 'nope' }).success).toBe(false);
  });
});
