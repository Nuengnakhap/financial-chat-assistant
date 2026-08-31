ALTER TABLE "conversations" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "outbox_events" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "outbox_events" ALTER COLUMN "published_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "session_tokens" ALTER COLUMN "issued_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "session_tokens" ALTER COLUMN "issued_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session_tokens" ALTER COLUMN "superseded_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "last_used_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "last_used_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "expires_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "absolute_expires_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "revoked_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now();