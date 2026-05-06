CREATE TABLE "agent_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"agent_pubkey" text NOT NULL,
	"identity_pda" text NOT NULL,
	"owner_wallet" text NOT NULL,
	"name" text NOT NULL,
	"metadata_uri" text,
	"metadata_hash" text,
	"chain_tx_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_identities_agent_pubkey_unique" UNIQUE("agent_pubkey"),
	CONSTRAINT "agent_identities_identity_pda_unique" UNIQUE("identity_pda")
);
--> statement-breakpoint
CREATE TABLE "agent_runtime_profile" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"adapter_config" jsonb NOT NULL,
	"external_agent_id" text,
	"desired_skills" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"skills_initialized_at" timestamp with time zone,
	"provisioning_state" text DEFAULT 'ready' NOT NULL,
	"provisioning_error" text,
	"workstation_id" text,
	"model_override" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"requested_by_deployment_id" uuid,
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
CREATE TABLE "auth_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_nonces_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'user' NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"kickoff_state" text DEFAULT 'not_started' NOT NULL,
	"kickoff_started_at" timestamp with time zone,
	"kickoff_completed_at" timestamp with time zone,
	"company_pda" text,
	"owner_wallet" text,
	"chain_nonce" integer,
	"chain_tx_signature" text,
	"locale" text,
	"metadata_uri" text,
	"metadata_hash" text,
	"chain_status" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_company_pda_unique" UNIQUE("company_pda")
);
--> statement-breakpoint
CREATE TABLE "company_profile" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"tagline" text,
	"logo_url" text,
	"niche" text,
	"founded_at" timestamp,
	"coverage_scope" text,
	"coverage_excluded" text,
	"content_pillars" text[] DEFAULT '{}'::text[] NOT NULL,
	"brand_voice" text,
	"forbidden_words" text[] DEFAULT '{}'::text[] NOT NULL,
	"mission" text,
	"vision" text,
	"target_audience" text,
	"usps" text[] DEFAULT '{}'::text[] NOT NULL,
	"core_offering" text,
	"service_catalog" text[] DEFAULT '{}'::text[] NOT NULL,
	"contact_email" text,
	"sales_email" text,
	"phone" text,
	"website_url" text,
	"blog_url" text,
	"newsletter_url" text,
	"docs_url" text,
	"social_handles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"treasury_address" text,
	"chains_covered" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"key" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"markdown" text NOT NULL,
	"source_type" text NOT NULL,
	"source_locator" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_owner" text NOT NULL,
	"source_repo" text NOT NULL,
	"source_path" text NOT NULL,
	"file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_roles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "deployment_runtime_state" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"state_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"session_id" text,
	"total_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cost_cents" bigint DEFAULT 0 NOT NULL,
	"last_trace_id" uuid,
	"last_trace_status" text,
	"last_error" text,
	"connection_state" text DEFAULT 'unknown' NOT NULL,
	"connection_checked_at" timestamp with time zone,
	"connection_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_skill_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"action" text DEFAULT 'install' NOT NULL,
	"skill_ref" text,
	"skill_url" text,
	"gateway_run_id" text,
	"last_error" text,
	"installed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_task_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"task_key" text NOT NULL,
	"session_params_json" jsonb,
	"session_display_id" text,
	"last_trace_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_workspace_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
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
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_identity_id" uuid NOT NULL,
	"deployment_pda" text NOT NULL,
	"deployment_index" integer NOT NULL,
	"role" text NOT NULL,
	"parent_deployment_index" integer,
	"adapter_id" text,
	"operating_wallet" text,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata_uri" text,
	"metadata_hash" text,
	"chain_tx_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_deployment_pda_unique" UNIQUE("deployment_pda")
);
--> statement-breakpoint
CREATE TABLE "routine_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"routine_id" uuid NOT NULL,
	"trigger_id" uuid,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"idempotency_key" text,
	"trigger_payload" jsonb,
	"linked_issue_id" uuid,
	"coalesced_into_trace_id" uuid,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"routine_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron_expression" text,
	"timezone" text,
	"next_run_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"public_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"goal_id" uuid,
	"parent_issue_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"assignee_deployment_id" uuid,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"concurrency_policy" text DEFAULT 'coalesce_if_active' NOT NULL,
	"catch_up_policy" text DEFAULT 'skip_missed' NOT NULL,
	"variables" jsonb,
	"last_triggered_at" timestamp with time zone,
	"last_enqueued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"author_deployment_id" uuid,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"mentions" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_number" integer NOT NULL,
	"assigned_deployment_id" uuid,
	"parent_task_id" uuid,
	"blocked_by_task_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"created_by_deployment_id" uuid,
	"acceptance_criteria" text,
	"title" text NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"task_type" text DEFAULT 'other' NOT NULL,
	"effort_level" text DEFAULT 'm' NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"due_date" timestamp with time zone,
	"linked_trace_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"stream" text,
	"level" text,
	"color" text,
	"message" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"task_id" uuid,
	"idempotency_key" text,
	"actor_type" text,
	"actor_id" text,
	"wake_payload" jsonb,
	"coalesced_count" integer DEFAULT 0 NOT NULL,
	"retry_of_trace_id" uuid,
	"invocation_source" text DEFAULT 'on_demand' NOT NULL,
	"trigger_detail" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"process_started_at" timestamp with time zone,
	"error" text,
	"error_code" text,
	"exit_code" integer,
	"signal" text,
	"log_store" text,
	"log_ref" text,
	"log_sha256" text,
	"log_bytes" bigint,
	"log_compressed" boolean DEFAULT false NOT NULL,
	"stdout_excerpt" text,
	"stderr_excerpt" text,
	"process_pid" integer,
	"process_group_id" integer,
	"process_loss_retry_count" integer DEFAULT 0 NOT NULL,
	"liveness_state" text,
	"liveness_reason" text,
	"next_action" text,
	"continuation_attempt" integer DEFAULT 0 NOT NULL,
	"failure_retry_attempt" integer DEFAULT 0 NOT NULL,
	"retry_reason" text,
	"scheduled_at" timestamp with time zone,
	"last_useful_action_at" timestamp with time zone,
	"context_snapshot" jsonb,
	"usage_json" jsonb,
	"result_json" jsonb,
	"session_id_before" text,
	"session_id_after" text,
	"external_trace_id" text,
	"conversation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"is_platform" boolean DEFAULT false NOT NULL,
	"pending_device_keypair" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_profile" ADD CONSTRAINT "agent_runtime_profile_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_profile" ADD CONSTRAINT "agent_runtime_profile_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_deployment_id_deployments_id_fk" FOREIGN KEY ("requested_by_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_api_keys" ADD CONSTRAINT "deployment_api_keys_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_api_keys" ADD CONSTRAINT "deployment_api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_runtime_state" ADD CONSTRAINT "deployment_runtime_state_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_runtime_state" ADD CONSTRAINT "deployment_runtime_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_skill_syncs" ADD CONSTRAINT "deployment_skill_syncs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_skill_syncs" ADD CONSTRAINT "deployment_skill_syncs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_task_sessions" ADD CONSTRAINT "deployment_task_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_task_sessions" ADD CONSTRAINT "deployment_task_sessions_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_task_sessions" ADD CONSTRAINT "deployment_task_sessions_last_trace_id_traces_id_fk" FOREIGN KEY ("last_trace_id") REFERENCES "public"."traces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_workspace_files" ADD CONSTRAINT "deployment_workspace_files_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_workspace_files" ADD CONSTRAINT "deployment_workspace_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_agent_identity_id_agent_identities_id_fk" FOREIGN KEY ("agent_identity_id") REFERENCES "public"."agent_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_trigger_id_routine_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."routine_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_assignee_deployment_id_deployments_id_fk" FOREIGN KEY ("assignee_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_deployment_id_deployments_id_fk" FOREIGN KEY ("author_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_deployment_id_deployments_id_fk" FOREIGN KEY ("assigned_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_deployment_id_deployments_id_fk" FOREIGN KEY ("created_by_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_retry_of_trace_id_traces_id_fk" FOREIGN KEY ("retry_of_trace_id") REFERENCES "public"."traces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_identities_owner" ON "agent_identities" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_profile_company" ON "agent_runtime_profile" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_agent_runtime_profile_workstation" ON "agent_runtime_profile" USING btree ("company_id","workstation_id") WHERE "agent_runtime_profile"."workstation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_approvals_company_status" ON "approvals" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "idx_approvals_deployment" ON "approvals" USING btree ("requested_by_deployment_id");--> statement-breakpoint
CREATE INDEX "idx_auth_nonces_wallet" ON "auth_nonces" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "idx_auth_nonces_expires_at" ON "auth_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_companies_owner" ON "companies" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_showcase_singleton" ON "companies" USING btree ("kind") WHERE kind = 'showcase';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_user_company_per_owner" ON "companies" USING btree ("owner_user_id") WHERE kind = 'user' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_company_skills_company" ON "company_skills" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_builtin_skill_key" ON "company_skills" USING btree ("key") WHERE "company_skills"."company_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_company_skill_key" ON "company_skills" USING btree ("company_id","key") WHERE "company_skills"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_deployment_api_keys_deployment" ON "deployment_api_keys" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "idx_deployment_api_keys_company" ON "deployment_api_keys" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_deployment_skill_sync" ON "deployment_skill_syncs" USING btree ("deployment_id","skill_key");--> statement-breakpoint
CREATE INDEX "idx_deployment_skill_syncs_status" ON "deployment_skill_syncs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_deployment_skill_syncs_company" ON "deployment_skill_syncs" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_task_sessions_company_deployment_adapter_task_uniq" ON "deployment_task_sessions" USING btree ("company_id","deployment_id","adapter_type","task_key");--> statement-breakpoint
CREATE INDEX "deployment_task_sessions_company_deployment_updated_idx" ON "deployment_task_sessions" USING btree ("company_id","deployment_id","updated_at");--> statement-breakpoint
CREATE INDEX "deployment_task_sessions_company_task_updated_idx" ON "deployment_task_sessions" USING btree ("company_id","task_key","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_deployment_workspace_file_name" ON "deployment_workspace_files" USING btree ("deployment_id","filename");--> statement-breakpoint
CREATE INDEX "idx_deployment_workspace_files_company" ON "deployment_workspace_files" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_deployments_company" ON "deployments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_deployments_identity" ON "deployments" USING btree ("agent_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_deployments_company_index" ON "deployments" USING btree ("company_id","deployment_index");--> statement-breakpoint
CREATE INDEX "idx_routine_runs_routine_triggered" ON "routine_runs" USING btree ("routine_id","triggered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_routine_runs_idem" ON "routine_runs" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_routine_triggers_routine" ON "routine_triggers" USING btree ("routine_id");--> statement-breakpoint
CREATE INDEX "idx_routine_triggers_enabled_next" ON "routine_triggers" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_routines_company" ON "routines" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_routines_assignee" ON "routines" USING btree ("assignee_deployment_id");--> statement-breakpoint
CREATE INDEX "idx_task_comments_task" ON "task_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_comments_company_created" ON "task_comments" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_company_status" ON "tasks" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tasks_company_number" ON "tasks" USING btree ("company_id","task_number");--> statement-breakpoint
CREATE INDEX "trace_events_trace_seq_idx" ON "trace_events" USING btree ("trace_id","seq");--> statement-breakpoint
CREATE INDEX "trace_events_company_trace_idx" ON "trace_events" USING btree ("company_id","trace_id");--> statement-breakpoint
CREATE INDEX "trace_events_company_created_idx" ON "trace_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "traces_conversation_id_idx" ON "traces" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "traces_company_deployment_started_idx" ON "traces" USING btree ("company_id","deployment_id","started_at");--> statement-breakpoint
CREATE INDEX "traces_company_liveness_idx" ON "traces" USING btree ("company_id","liveness_state","created_at");--> statement-breakpoint
CREATE INDEX "traces_status_created_idx" ON "traces" USING btree ("status","created_at");