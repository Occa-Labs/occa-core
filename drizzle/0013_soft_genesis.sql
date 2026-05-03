ALTER TABLE "agents" ADD COLUMN "instructions_root_path" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "instructions_entry_file" text DEFAULT 'AGENTS.md' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "instructions_materialized_at" timestamp with time zone;