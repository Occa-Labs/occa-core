ALTER TABLE "tasks" ADD COLUMN "task_number" integer;--> statement-breakpoint
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at, id) AS rn
  FROM "tasks"
)
UPDATE "tasks" t SET "task_number" = n.rn FROM numbered n WHERE t.id = n.id;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "task_number" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tasks_company_number" ON "tasks" USING btree ("company_id","task_number");
