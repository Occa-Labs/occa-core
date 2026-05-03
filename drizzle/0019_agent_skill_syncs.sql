CREATE TABLE IF NOT EXISTS "agent_skill_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"action" text DEFAULT 'install' NOT NULL,
	"skill_ref" text,
	"skill_url" text,
	"last_error" text,
	"installed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_skill_syncs" ADD CONSTRAINT "agent_skill_syncs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_skill_syncs" ADD CONSTRAINT "agent_skill_syncs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_agent_skill_sync" ON "agent_skill_syncs" USING btree ("agent_id","skill_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_skill_syncs_status" ON "agent_skill_syncs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_skill_syncs_company" ON "agent_skill_syncs" USING btree ("company_id");
