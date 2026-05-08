ALTER TABLE "tasks" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "archive_reason" text;--> statement-breakpoint
CREATE INDEX "idx_tasks_company_active" ON "tasks" USING btree ("company_id","status") WHERE archived_at IS NULL;