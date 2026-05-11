CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid,
	"deployment_id" uuid,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"format" text DEFAULT 'markdown' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_documents_company_created" ON "documents" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_documents_task" ON "documents" USING btree ("task_id");