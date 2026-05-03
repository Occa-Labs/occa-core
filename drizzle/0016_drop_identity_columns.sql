ALTER TABLE "agents" DROP COLUMN IF EXISTS "instructions_root_path";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "instructions_entry_file";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "instructions_materialized_at";
