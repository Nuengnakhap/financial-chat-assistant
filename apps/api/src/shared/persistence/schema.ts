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

/**
 * Every instant is stored to the millisecond, not to PostgreSQL's default
 * microsecond, because a JavaScript `Date` holds milliseconds and so does the
 * ISO string every one of these columns leaves as. Storing more precision than
 * anything that reads them can represent means a value read out and used again
 * is not the value stored — which is not academic: a keyset cursor built from
 * `updated_at` compared against a microsecond column silently steps over any
 * row that shares the millisecond it was truncated to, and the page after it
 * simply loses a conversation.
 *
 * Rounding on the way in is PostgreSQL's, so the stored value and the one the
 * application read back are the same instant, and the tie between two rows in
 * the same millisecond is broken by the id already in every ordering.
 */
const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
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
    createdAt: instant('created_at').notNull().defaultNow(),
    lastUsedAt: instant('last_used_at').notNull().defaultNow(),
    expiresAt: instant('expires_at').notNull(),
    /** Refreshing slides `expires_at` forward; nothing slides past this. */
    absoluteExpiresAt: instant('absolute_expires_at').notNull(),
    revokedAt: instant('revoked_at'),
  },
  (table) => [
    // S1: a family is a chain, so only one link of it can be live at a time.
    uniqueIndex('uq_sessions_family_active')
      .on(table.familyId)
      .where(sql`${table.revokedAt} IS NULL`),
    check('chk_sessions_lifetime', sql`${table.expiresAt} > ${table.createdAt}`),
    // S4: a session used every day still ends. The cap is a property of the row
    // rather than something the rotation query has to remember to apply.
    // Together with chk_sessions_lifetime this also puts the cap after
    // `created_at`, so saying so again here would add a clause nothing can reach.
    check('chk_sessions_within_absolute', sql`${table.expiresAt} <= ${table.absoluteExpiresAt}`),
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
    issuedAt: instant('issued_at').notNull().defaultNow(),
    supersededAt: instant('superseded_at'),
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
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
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
    /** Of the input, how many the provider served from its own cache and charged less for. */
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /**
     * The claim held on the asker's budget while this answer is written, and the
     * window it belongs to. On the row rather than in the process that made it,
     * because whatever ends a generation has to give it back — and the thing
     * that ends one whose pod died is a janitor that never saw the request.
     */
    reservationId: uuid('reservation_id'),
    reservationWindow: instant('reservation_window'),
    /**
     * Integer micro-USD, read back as a bigint. No float touches this column.
     * The default is written as SQL because drizzle-kit cannot serialise a
     * JavaScript bigint into a migration snapshot.
     */
    costMicroUsd: bigint('cost_micro_usd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    seq: integer().notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
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
    // G2: a claim is either whole or absent. Half of one cannot be given back,
    // and the half that is missing is always the one needed to find it.
    check(
      'chk_reservation_is_whole',
      sql`(${table.reservationId} IS NULL) = (${table.reservationWindow} IS NULL)`,
    ),
  ],
);

/**
 * What has been spent, and the record that outlives the answer that spent it.
 *
 * Redis holds the counter a limit is enforced by; this is where the counter is
 * rebuilt from when Redis has been restarted, and the reason a window survives
 * that at all. It is a ledger, so nothing here is ever updated — a row is one
 * generation, once.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Deliberately not a foreign key. Deleting a conversation deletes its
     * messages, and money already spent must not go with them — otherwise
     * deleting a conversation is how somebody gives themselves their quota
     * back, and the rebuilt total is lower than the truth.
     */
    messageId: uuid('message_id').notNull(),
    windowStart: instant('window_start').notNull(),
    model: text().notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cachedInputTokens: integer('cached_input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'bigint' }).notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    // B1: one generation is charged once. A second write is the constraint
    // speaking rather than a second row, which is what makes recording it from
    // more than one place safe.
    unique('uq_usage_message').on(table.messageId),
    check('chk_usage_cost_not_negative', sql`${table.costMicroUsd} >= 0`),
    // The rebuild reads exactly this: one person, one window.
    index('idx_usage_user_window').on(table.userId, table.windowStart),
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
    createdAt: instant('created_at').notNull().defaultNow(),
    publishedAt: instant('published_at'),
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

export type UsageEventRow = typeof usageEvents.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionTokenRow = typeof sessionTokens.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type OutboxEventRow = typeof outboxEvents.$inferSelect;
