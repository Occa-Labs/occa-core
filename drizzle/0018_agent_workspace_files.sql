CREATE TABLE "agent_workspace_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content" text NOT NULL,
	"source" text DEFAULT 'template' NOT NULL,
	"template_origin" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_workspace_files" ADD CONSTRAINT "agent_workspace_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_files" ADD CONSTRAINT "agent_workspace_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_agent_workspace_file_name" ON "agent_workspace_files" USING btree ("agent_id","filename");--> statement-breakpoint
CREATE INDEX "idx_agent_workspace_files_company" ON "agent_workspace_files" USING btree ("company_id");
