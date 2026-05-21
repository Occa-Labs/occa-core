CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"task_id" uuid,
	"amount_lamports" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_signature" text,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runtime_profile" ADD COLUMN "task_rate_lamports" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invoices_company_status" ON "invoices" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "idx_invoices_deployment" ON "invoices" USING btree ("deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_invoices_task" ON "invoices" USING btree ("task_id") WHERE "invoices"."task_id" IS NOT NULL;