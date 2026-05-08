CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"yaml_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"yaml_text" text NOT NULL,
	"parsed_definition" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_workflows_company_yaml_id" ON "workflows" USING btree ("company_id","yaml_id");--> statement-breakpoint
CREATE INDEX "idx_workflows_company_enabled" ON "workflows" USING btree ("company_id","enabled");