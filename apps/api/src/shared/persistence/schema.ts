import { DOMAIN_EVENT_TYPES } from '@fca/domain';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * One file so that tables which reference each other cannot end up importing
 * each other, and so every constraint is read next to the rule it enforces.
 * The invariant ids in the comments are the ones in the domain model.
 *
 * `packages/domain` never sees this file: the schema is infrastructure, and
 * dependency-cruiser fails the build if a business rule reaches for it.
 */

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Case-insensitive: signing up as Ada@x.com and ada@x.com must not be two people.
    uniqueIndex('uq_users_email').on(sql`lower(${table.email})`),
    check('chk_users_email_shape', sql`position('@' in ${table.email}) > 1`),
  ],
);

/**
 * A sign-in that is still alive. The refresh token itself is not here: it lives
 * in `session_tokens` so that "no two sessions ever answer to the same token"
 * is one primary key instead of a rule spread across two nullable columns,
 * where the same hash could be the current one on one row and the previous one
 * on another and nothing would say which.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Rotation issues a new token, never a new family — theft is revoked by lineage. */
    familyId: uuid('family_id').notNull(),
    device: text().notNull(),
    /** A hash, not an address: the session list shows it, so it must not be one. */
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // S1: a family is a chain, so only one link of it can be live at a time.
    uniqueIndex('uq_sessions_family_active')
      .on(table.familyId)
      .where(sql`${table.revokedAt} IS NULL`),
    check('chk_sessions_lifetime', sql`${table.expiresAt} > ${table.createdAt}`),
    // Bounded by what `sessionView` in @fca/contracts will render.
    check('chk_sessions_device_length', sql`char_length(${table.device}) between 1 and 200`),
    check('chk_sessions_ip_hash_length', sql`char_length(${table.ipHash}) = 64`),
    // Not partial, unlike the unique index above: PostgreSQL does not index the
    // child side of a foreign key, and a partial one cannot serve the lookup
    // that `ON DELETE CASCADE` runs, because that query says nothing about
    // `revoked_at` for the planner to match. One index covers both the owner's
    // list and the cascade rather than carrying a second for the latter.
    index('idx_sessions_owner_recent').on(table.userId, table.lastUsedAt),
  ],
);

/**
 * Every refresh token ever issued for a session, as a SHA-256 digest. Keeping
 * the superseded ones is what makes reuse detectable: presenting a token that
 * has already been rotated away is the signal that a copy of it exists.
 */
export const sessionTokens = pgTable(
  'session_tokens',
  {
    // S2: the hash is the key, so no two sessions can answer to one token in
    // any state. This is the constraint the two-column shape could not express.
    hash: text().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (table) => [
    // S3: one token per session is usable; the rest are history.
    uniqueIndex('uq_session_tokens_live')
      .on(table.sessionId)
      .where(sql`${table.supersededAt} IS NULL`),
    // Superseded rows are kept on purpose, so this table only grows. Without a
    // plain index the cascade from a deleted session scans all of it, once per
    // session, and so does the retention pass that trims old lineages.
    index('idx_session_tokens_session').on(table.sessionId),
    check('chk_session_tokens_hash_shape', sql`${table.hash} ~ '^[0-9a-f]{64}$'`),
    check(
      'chk_session_tokens_order',
      sql`${table.supersededAt} IS NULL OR ${table.supersededAt} >= ${table.issuedAt}`,
    ),
  ],
);

export const conversationState = pgEnum('conversation_state', ['active', 'deleting']);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid().primaryKey().defaultRandom(),
    // C1: a conversation has exactly one owner, and loses its rows with them.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    state: conversationState().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // C2: a title is never blank and never unbounded.
    check('chk_conversation_title_length', sql`char_length(${table.title}) between 1 and 120`),
    // The list page orders by this pair; without the index it degrades to a sort.
    index('idx_conversations_owner_recent').on(table.userId, table.updatedAt, table.id),
  ],
);

export const messageRole = pgEnum('message_role', ['user', 'assistant']);
export const messageStatus = pgEnum('message_status', [
  'generating',
  'complete',
  'stopped',
  'error',
]);

export const messages = pgTable(
  'messages',
  {
    id: uuid().primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Generated by the browser; null for anything the server originated. */
    clientMessageId: uuid('client_message_id'),
    role: messageRole().notNull(),
    parts: jsonb().notNull(),
    status: messageStatus().notNull().default('complete'),
    verification: jsonb(),
    model: text(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /**
     * Integer micro-USD, read back as a bigint. No float touches this column.
     * The default is written as SQL because drizzle-kit cannot serialise a
     * JavaScript bigint into a migration snapshot.
     */
    costMicroUsd: bigint('cost_micro_usd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    seq: integer().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // M1: ordering within a conversation is unique, so a page can never repeat
    // or skip a message.
    unique('uq_message_seq').on(table.conversationId, table.seq),
    // M2: the same send retried reaches the same message instead of a duplicate.
    unique('uq_message_client_id').on(table.conversationId, table.clientMessageId),
    // M3: an assistant message the user sees as finished and one that was
    // verified are the same row. This is the no-hallucination guarantee in the
    // only place that cannot be bypassed by a bug in application code.
    check(
      'chk_complete_has_verification',
      sql`${table.role} <> 'assistant' OR ${table.status} <> 'complete' OR ${table.verification} IS NOT NULL`,
    ),
    check('chk_message_seq_positive', sql`${table.seq} >= 1`),
    // M6: a user message is neither empty nor a megabyte of prompt injection.
    check(
      'chk_user_message_length',
      sql`${table.role} <> 'user' OR (jsonb_typeof(${table.parts}) = 'array' AND char_length(${table.parts}::text) between 3 and 8192)`,
    ),
    // G1: one generation at a time per conversation, held by the database
    // rather than only by a Redis lock that a partition can lose.
    uniqueIndex('uq_active_generation')
      .on(table.conversationId)
      .where(sql`${table.status} = 'generating'`),
    index('idx_messages_created').on(table.createdAt),
  ],
);

/**
 * The other half of every state change that has to reach somewhere else. Written
 * in the same transaction as the change, drained afterwards — so there is no
 * moment where the state exists and the notification does not, or the reverse.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey(),
    aggregate: text().notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    // The relay reads this column back and hands it to consumers as a
    // DomainEventType. Holding the closed set here is what makes that safe:
    // a row written by a newer deploy cannot arrive with a type an older relay
    // would silently mislabel.
    // `sql.raw` because a parameterised list would be emitted into the migration
    // as placeholders. The values are our own constants, never input.
    check(
      'chk_outbox_type',
      sql`${table.type} IN (${sql.raw(DOMAIN_EVENT_TYPES.map((type) => `'${type}'`).join(', '))})`,
    ),
    // Partial: the relay only ever looks at what it has not published, and the
    // index stays small however long the table grows.
    index('idx_outbox_unpublished')
      .on(table.id)
      .where(sql`${table.publishedAt} IS NULL`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionTokenRow = typeof sessionTokens.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type OutboxEventRow = typeof outboxEvents.$inferSelect;
