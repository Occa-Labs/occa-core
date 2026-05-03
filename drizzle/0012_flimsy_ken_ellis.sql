CREATE TABLE "agent_hire_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"requested_by_agent_id" uuid NOT NULL,
	"approval_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_name" text NOT NULL,
	"proposed_role" text NOT NULL,
	"proposed_reports_to_agent_id" uuid,
	"proposed_adapter_type" text NOT NULL,
	"proposed_adapter_config" jsonb NOT NULL,
	"proposed_desired_skills" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"proposed_capabilities" text,
	"reason" text NOT NULL,
	"source_task_id" uuid,
	"materialized_agent_id" uuid,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"requested_by_agent_id" uuid,
	"action_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reports_to_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "can_create_agents" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_hire_requests" ADD CONSTRAINT "agent_hire_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_hire_requests" ADD CONSTRAINT "agent_hire_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_hire_requests" ADD CONSTRAINT "agent_hire_requests_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_hire_requests" ADD CONSTRAINT "agent_hire_requests_proposed_reports_to_agent_id_agents_id_fk" FOREIGN KEY ("proposed_reports_to_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_hire_requests" ADD CONSTRAINT "agent_hire_requests_materialized_agent_id_agents_id_fk" FOREIGN KEY ("materialized_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_hire_requests" ADD CONSTRAINT "agent_hire_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_hires_company_status" ON "agent_hire_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "idx_agent_hires_requester" ON "agent_hire_requests" USING btree ("requested_by_agent_id");--> statement-breakpoint
CREATE INDEX "idx_approvals_company_status" ON "approvals" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "idx_approvals_agent" ON "approvals" USING btree ("requested_by_agent_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_agent_id_agents_id_fk" FOREIGN KEY ("reports_to_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agents_reports_to" ON "agents" USING btree ("reports_to_agent_id") WHERE reports_to_agent_id IS NOT NULL;