import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { conversations, messages, sessionTokens, sessions, users } from '../schema';
import { insertConversation, insertUser, startHarness, violationOf, type Harness } from './harness';

/**
 * Every invariant the domain states is also held by the database, because
 * application code is the layer most likely to have the bug. These tests are the
 * proof that each `CHECK` and `UNIQUE` rejects what it claims to — a constraint
 * nobody has watched fail is a constraint that might be misspelled.
 */

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

const userMessage = (conversationId: string, seq: number) => ({
  conversationId,
  role: 'user' as const,
  parts: [{ kind: 'text', text: 'What was Apple revenue in 2024?' }],
  status: 'complete' as const,
  seq,
});

const assistant = (conversationId: string, seq: number, status: 'complete' | 'stopped') => ({
  conversationId,
  role: 'assistant' as const,
  parts: [{ kind: 'text', text: 'Apple revenue in 2024 was $391.0B.' }],
  status,
  seq,
});

const generating = (conversationId: string, seq: number) => ({
  conversationId,
  role: 'assistant' as const,
  parts: [],
  status: 'generating' as const,
  seq,
});

describe('C2 — a conversation title is never blank and never unbounded', () => {
  it('accepts a title within range', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');

    await expect(
      h.db.insert(conversations).values({ userId, title: 'Revenue' }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['blank', ''],
    ['longer than 120 characters', 'x'.repeat(121)],
  ])('rejects a title that is %s', async (_name, title) => {
    const userId = await insertUser(h.db, 'ada@example.com');

    const reason = await violationOf(() => h.db.insert(conversations).values({ userId, title }));

    expect(reason).toContain('chk_conversation_title_length');
  });
});

describe('C1 — a conversation belongs to exactly one user', () => {
  it('cannot exist without one', async () => {
    const reason = await violationOf(() =>
      h.db
        .insert(conversations)
        .values({ userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', title: 'Orphan' }),
    );

    expect(reason.toLowerCase()).toContain('foreign key');
  });

  it('goes with the user when the user goes', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);
    await h.db.insert(messages).values(userMessage(conversationId, 1));

    await h.db.delete(users);

    expect(await h.db.select().from(conversations)).toEqual([]);
    expect(await h.db.select().from(messages)).toEqual([]);
  });
});

describe('M1 — ordering within a conversation is unique', () => {
  it('refuses a second message at the same position', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);
    await h.db.insert(messages).values(userMessage(conversationId, 1));

    const reason = await violationOf(() =>
      h.db.insert(messages).values(userMessage(conversationId, 1)),
    );

    expect(reason).toContain('uq_message_seq');
  });

  it('allows the same position in a different conversation', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const first = await insertConversation(h.db, userId);
    const second = await insertConversation(h.db, userId);
    await h.db.insert(messages).values(userMessage(first, 1));

    await expect(h.db.insert(messages).values(userMessage(second, 1))).resolves.toBeDefined();
  });

  it('refuses position zero, so a page cursor can never be ambiguous', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);

    const reason = await violationOf(() =>
      h.db.insert(messages).values(userMessage(conversationId, 0)),
    );

    expect(reason).toContain('chk_message_seq_positive');
  });
});

describe('M2 — a retried send reaches the same message', () => {
  const clientMessageId = '01936d1e-8f7a-7c3e-b8d4-9a1e2f3b4c5d';

  it('refuses the same client id twice in one conversation', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);
    await h.db.insert(messages).values({ ...userMessage(conversationId, 1), clientMessageId });

    const reason = await violationOf(() =>
      h.db.insert(messages).values({ ...userMessage(conversationId, 2), clientMessageId }),
    );

    expect(reason).toContain('uq_message_client_id');
  });

  it('leaves server-originated messages unconstrained, since they have no client id', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);
    await h.db.insert(messages).values(assistant(conversationId, 1, 'stopped'));

    // Two NULLs are distinct in Postgres, which is what makes this work.
    await expect(
      h.db.insert(messages).values(assistant(conversationId, 2, 'stopped')),
    ).resolves.toBeDefined();
  });
});

describe('M3 — a complete answer always carries its evidence', () => {
  it('refuses a complete assistant message with no verification', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);

    // The whole no-hallucination guarantee, in the one place a bug in the
    // application layer cannot walk past.
    const reason = await violationOf(() =>
      h.db.insert(messages).values(assistant(conversationId, 1, 'complete')),
    );

    expect(reason).toContain('chk_complete_has_verification');
  });

  it('accepts it once the report is attached', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);

    await expect(
      h.db.insert(messages).values({
        ...assistant(conversationId, 1, 'complete'),
        verification: { verdict: 'pass', checkedClaims: [], violations: [] },
      }),
    ).resolves.toBeDefined();
  });

  it('does not require one while the answer is unfinished', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);

    await expect(
      h.db.insert(messages).values(assistant(conversationId, 1, 'stopped')),
    ).resolves.toBeDefined();
  });

  it('never demands one from a user message', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);

    await expect(
      h.db.insert(messages).values(userMessage(conversationId, 1)),
    ).resolves.toBeDefined();
  });

  it('refuses an update that completes a message without one', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);
    await h.db.insert(messages).values(generating(conversationId, 1));

    // The constraint has to hold on the path the runner actually takes, which
    // is an UPDATE at the end of a generation, not only on INSERT.
    const reason = await violationOf(() => h.db.update(messages).set({ status: 'complete' }));

    expect(reason).toContain('chk_complete_has_verification');
  });
});

describe('G1 — one generation at a time per conversation', () => {
  it('refuses a second generation while one is running', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);
    await h.db.insert(messages).values(generating(conversationId, 1));

    // Held by the database, not only by a Redis lock a partition could lose.
    const reason = await violationOf(() =>
      h.db.insert(messages).values(generating(conversationId, 2)),
    );

    expect(reason).toContain('uq_active_generation');
  });

  it('allows the next one once the first reaches a terminal state', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);
    await h.db.insert(messages).values(generating(conversationId, 1));

    await h.db.update(messages).set({ status: 'stopped' });

    await expect(
      h.db.insert(messages).values(generating(conversationId, 2)),
    ).resolves.toBeDefined();
  });

  it('does not stop two conversations generating at once', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const first = await insertConversation(h.db, userId);
    const second = await insertConversation(h.db, userId);
    await h.db.insert(messages).values(generating(first, 1));

    await expect(h.db.insert(messages).values(generating(second, 1))).resolves.toBeDefined();
  });
});

describe('M6 — a user message is neither empty nor a megabyte of prompt', () => {
  it('refuses an oversized one', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const conversationId = await insertConversation(h.db, userId);

    const reason = await violationOf(() =>
      h.db.insert(messages).values({
        conversationId,
        role: 'user',
        parts: [{ kind: 'text', text: 'x'.repeat(9_000) }],
        status: 'complete',
        seq: 1,
      }),
    );

    expect(reason).toContain('chk_user_message_length');
  });
});

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const FAMILY = 'aaaaaaaa-1111-4111-8111-111111111111';

const session = (userId: string, familyId = FAMILY) => ({
  userId,
  familyId,
  device: 'Firefox on macOS',
  ipHash: 'f'.repeat(64),
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
  absoluteExpiresAt: new Date(Date.now() + 90 * 86_400_000),
});

async function insertSession(userId: string, familyId = FAMILY): Promise<string> {
  const [row] = await h.db
    .insert(sessions)
    .values(session(userId, familyId))
    .returning({ id: sessions.id });

  if (row === undefined) throw new Error('session insert returned no row');
  return row.id;
}

describe('S1 — a family has one live session at a time', () => {
  it('refuses a second session in a family that is still live', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    await insertSession(userId);

    const reason = await violationOf(() => h.db.insert(sessions).values(session(userId)));

    expect(reason).toContain('uq_sessions_family_active');
  });

  it('allows a new one once the family is revoked', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    await insertSession(userId);

    await h.db.update(sessions).set({ revokedAt: new Date() });

    await expect(h.db.insert(sessions).values(session(userId))).resolves.toBeDefined();
  });

  it('does not stop two different families being live at once', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    await insertSession(userId);

    await expect(
      h.db.insert(sessions).values(session(userId, 'bbbbbbbb-1111-4111-8111-111111111111')),
    ).resolves.toBeDefined();
  });
});

describe('S2 — a refresh token answers to exactly one session', () => {
  it('refuses the same hash on a second session, whatever its state', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const first = await insertSession(userId);
    const second = await insertSession(userId, 'bbbbbbbb-1111-4111-8111-111111111111');
    await h.db.insert(sessionTokens).values({ hash: HASH_A, sessionId: first });
    // Superseded on one row and current on another is precisely the ambiguity
    // the two-column shape allowed and this key forbids.
    await h.db.update(sessionTokens).set({ supersededAt: new Date() });

    const reason = await violationOf(() =>
      h.db.insert(sessionTokens).values({ hash: HASH_A, sessionId: second }),
    );

    expect(reason).toContain('session_tokens_pkey');
  });

  it('refuses a hash that is not a sha-256 digest', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const sessionId = await insertSession(userId);

    const reason = await violationOf(() =>
      h.db.insert(sessionTokens).values({ hash: 'not-a-digest', sessionId }),
    );

    expect(reason).toContain('chk_session_tokens_hash_shape');
  });
});

describe('S3 — a session has one usable token at a time', () => {
  it('refuses a second live token', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const sessionId = await insertSession(userId);
    await h.db.insert(sessionTokens).values({ hash: HASH_A, sessionId });

    const reason = await violationOf(() =>
      h.db.insert(sessionTokens).values({ hash: HASH_B, sessionId }),
    );

    expect(reason).toContain('uq_session_tokens_live');
  });

  it('allows the next one once the previous is superseded', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const sessionId = await insertSession(userId);
    await h.db.insert(sessionTokens).values({ hash: HASH_A, sessionId });

    await h.db.update(sessionTokens).set({ supersededAt: new Date() });

    await expect(
      h.db.insert(sessionTokens).values({ hash: HASH_B, sessionId }),
    ).resolves.toBeDefined();
  });

  it('refuses a token superseded before it was issued', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const sessionId = await insertSession(userId);

    const reason = await violationOf(() =>
      h.db.insert(sessionTokens).values({
        hash: HASH_A,
        sessionId,
        issuedAt: new Date(),
        supersededAt: new Date(Date.now() - 1_000),
      }),
    );

    expect(reason).toContain('chk_session_tokens_order');
  });
});

describe('a session is bounded and belongs to a user', () => {
  it('refuses one that has already expired', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');

    const reason = await violationOf(() =>
      h.db
        .insert(sessions)
        .values({ ...session(userId), expiresAt: new Date(Date.now() - 86_400_000) }),
    );

    expect(reason).toContain('chk_sessions_lifetime');
  });

  it.each([
    ['blank', '', 'chk_sessions_device_length'],
    ['longer than the contract renders', 'x'.repeat(201), 'chk_sessions_device_length'],
  ])('refuses a device name that is %s', async (_name, device, constraint) => {
    const userId = await insertUser(h.db, 'ada@example.com');

    const reason = await violationOf(() =>
      h.db.insert(sessions).values({ ...session(userId), device }),
    );

    expect(reason).toContain(constraint);
  });

  it('refuses an address where a hash of one belongs', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');

    const reason = await violationOf(() =>
      h.db.insert(sessions).values({ ...session(userId), ipHash: '203.0.113.7' }),
    );

    expect(reason).toContain('chk_sessions_ip_hash_length');
  });

  it('refuses an expiry beyond the absolute cap, on insert and on update alike', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const beyond = new Date(Date.now() + 200 * 86_400_000);

    const onInsert = await violationOf(() =>
      h.db.insert(sessions).values({ ...session(userId), expiresAt: beyond }),
    );
    await insertSession(userId);
    // S4 has to hold on the path refreshing actually takes, which is an UPDATE.
    const onUpdate = await violationOf(() => h.db.update(sessions).set({ expiresAt: beyond }));

    expect(onInsert).toContain('chk_sessions_within_absolute');
    expect(onUpdate).toContain('chk_sessions_within_absolute');
  });

  it('takes its sessions and their tokens with the user', async () => {
    const userId = await insertUser(h.db, 'ada@example.com');
    const sessionId = await insertSession(userId);
    await h.db.insert(sessionTokens).values({ hash: HASH_A, sessionId });

    await h.db.delete(users);

    expect(await h.db.select().from(sessions)).toEqual([]);
    expect(await h.db.select().from(sessionTokens)).toEqual([]);
  });
});

describe('identity', () => {
  it('treats an email as the same account whatever the case', async () => {
    await insertUser(h.db, 'Ada@example.com');

    expect(await violationOf(() => insertUser(h.db, 'ada@EXAMPLE.com'))).toContain(
      'uq_users_email',
    );
  });

  it('refuses something that is not an address', async () => {
    expect(await violationOf(() => insertUser(h.db, 'not-an-email'))).toContain(
      'chk_users_email_shape',
    );
  });
});
