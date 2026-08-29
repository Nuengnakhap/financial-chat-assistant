CREATE TYPE "public"."conversation_state" AS ENUM('active', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('generating', 'complete', 'stopped', 'error');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"state" "conversation_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_conversation_title_length" CHECK (char_length("conversations"."title") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"client_message_id" uuid,
	"role" "message_role" NOT NULL,
	"parts" jsonb NOT NULL,
	"status" "message_status" DEFAULT 'complete' NOT NULL,
	"verification" jsonb,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_message_seq" UNIQUE("conversation_id","seq"),
	CONSTRAINT "uq_message_client_id" UNIQUE("conversation_id","client_message_id"),
	CONSTRAINT "chk_complete_has_verification" CHECK ("messages"."role" <> 'assistant' OR "messages"."status" <> 'complete' OR "messages"."verification" IS NOT NULL),
	CONSTRAINT "chk_message_seq_positive" CHECK ("messages"."seq" >= 1),
	CONSTRAINT "chk_user_message_length" CHECK ("messages"."role" <> 'user' OR (jsonb_typeof("messages"."parts") = 'array' AND char_length("messages"."parts"::text) between 3 and 8192))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"aggregate" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_users_email_shape" CHECK (position('@' in "users"."email") > 1)
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversations_owner_recent" ON "conversations" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_active_generation" ON "messages" USING btree ("conversation_id") WHERE "messages"."status" = 'generating';--> statement-breakpoint
CREATE INDEX "idx_messages_created" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_unpublished" ON "outbox_events" USING btree ("id") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_email" ON "users" USING btree (lower("email"));