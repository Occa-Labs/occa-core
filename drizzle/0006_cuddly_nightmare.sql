CREATE TABLE "company_brain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"visibility" text DEFAULT 'all' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_brain" ADD CONSTRAINT "company_brain_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_company_brain_path" ON "company_brain" USING btree ("company_id","path");--> statement-breakpoint
CREATE INDEX "idx_company_brain_company" ON "company_brain" USING btree ("company_id");