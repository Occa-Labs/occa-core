ALTER TABLE "agent_runtime_state" ADD COLUMN "connection_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN "connection_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN "connection_error" text;