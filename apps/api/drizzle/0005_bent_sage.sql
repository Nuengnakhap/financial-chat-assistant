CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"cached_input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_micro_usd" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_usage_message" UNIQUE("message_id"),
	CONSTRAINT "chk_usage_cost_not_negative" CHECK ("usage_events"."cost_micro_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "cached_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reservation_window" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_user_window" ON "usage_events" USING btree ("user_id","window_start");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "chk_reservation_is_whole" CHECK (("messages"."reservation_id" IS NULL) = ("messages"."reservation_window" IS NULL));