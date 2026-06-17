ALTER TABLE "routines" ADD COLUMN "workflow_yaml_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workflow_step_index" integer;