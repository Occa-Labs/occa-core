CREATE TABLE "company_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"credentials_encrypted" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_call_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"deployment_id" uuid,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"result_summary" jsonb,
	"error_code" text,
	"error_message" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_tools" ADD CONSTRAINT "company_tools_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_logs" ADD CONSTRAINT "tool_call_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_logs" ADD CONSTRAINT "tool_call_logs_tool_id_company_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."company_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_logs" ADD CONSTRAINT "tool_call_logs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_company_tool_type_label" ON "company_tools" USING btree ("company_id","type","label");--> statement-breakpoint
CREATE INDEX "idx_company_tools_company" ON "company_tools" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_company_tools_status" ON "company_tools" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tool_call_logs_company_created" ON "tool_call_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tool_call_logs_tool_created" ON "tool_call_logs" USING btree ("tool_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tool_call_logs_status" ON "tool_call_logs" USING btree ("status");