CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"deployment_id" uuid NOT NULL,
	"caller_deployment_id" uuid,
	"parent_thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_caller_deployment_id_deployments_id_fk" FOREIGN KEY ("caller_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_parent_thread_id_chat_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chat_threads_user_ceo" ON "chat_threads" USING btree ("company_id","deployment_id") WHERE kind = 'user_ceo';--> statement-breakpoint
CREATE INDEX "idx_chat_threads_parent" ON "chat_threads" USING btree ("parent_thread_id");--> statement-breakpoint

-- Backfill: create one user_ceo thread per distinct (company,deployment)
-- pair seen in chat_messages. Companies have an owner_user_id so the
-- user side of each thread is known.
INSERT INTO "chat_threads" ("company_id", "kind", "user_id", "deployment_id")
SELECT DISTINCT cm.company_id, 'user_ceo', c.owner_user_id, cm.deployment_id
FROM "chat_messages" cm
JOIN "companies" c ON c.id = cm.company_id;
--> statement-breakpoint

DROP INDEX "idx_chat_messages_thread";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "thread_id" uuid;--> statement-breakpoint

-- Backfill chat_messages.thread_id from the implicit (company,deployment) key.
UPDATE "chat_messages" cm
SET "thread_id" = ct.id
FROM "chat_threads" ct
WHERE ct.company_id = cm.company_id
  AND ct.deployment_id = cm.deployment_id
  AND ct.kind = 'user_ceo';
--> statement-breakpoint

ALTER TABLE "chat_messages" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_messages_thread_chronological" ON "chat_messages" USING btree ("thread_id","created_at");--> statement-breakpoint

ALTER TABLE "tasks" ADD COLUMN "originating_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_originating_thread_id_chat_threads_id_fk" FOREIGN KEY ("originating_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Backfill tasks.originating_thread_id from the deprecated originating_user_id
-- by joining through the user's user_ceo thread in the same company.
UPDATE "tasks" t
SET "originating_thread_id" = ct.id
FROM "chat_threads" ct
JOIN "deployments" d ON d.id = ct.deployment_id
WHERE t.originating_user_id IS NOT NULL
  AND ct.user_id = t.originating_user_id
  AND ct.kind = 'user_ceo'
  AND d.role = 'ceo';
