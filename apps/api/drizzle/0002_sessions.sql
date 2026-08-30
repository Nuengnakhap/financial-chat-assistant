CREATE TABLE "session_tokens" (
	"hash" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "chk_session_tokens_hash_shape" CHECK ("session_tokens"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "chk_session_tokens_order" CHECK ("session_tokens"."superseded_at" IS NULL OR "session_tokens"."superseded_at" >= "session_tokens"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"device" text NOT NULL,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "chk_sessions_lifetime" CHECK ("sessions"."expires_at" > "sessions"."created_at"),
	CONSTRAINT "chk_sessions_device_length" CHECK (char_length("sessions"."device") between 1 and 200),
	CONSTRAINT "chk_sessions_ip_hash_length" CHECK (char_length("sessions"."ip_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "session_tokens" ADD CONSTRAINT "session_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_tokens_live" ON "session_tokens" USING btree ("session_id") WHERE "session_tokens"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_session_tokens_session" ON "session_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sessions_family_active" ON "sessions" USING btree ("family_id") WHERE "sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_sessions_owner_recent" ON "sessions" USING btree ("user_id","last_used_at");