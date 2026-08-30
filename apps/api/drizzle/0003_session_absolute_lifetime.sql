ALTER TABLE "sessions" ADD COLUMN "absolute_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "sessions" SET "absolute_expires_at" = "expires_at" WHERE "absolute_expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "absolute_expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "chk_sessions_within_absolute" CHECK ("sessions"."expires_at" <= "sessions"."absolute_expires_at");
