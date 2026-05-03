ALTER TABLE "tasks" ADD COLUMN "task_type" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "effort_level" text DEFAULT 'm' NOT NULL;