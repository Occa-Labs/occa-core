CREATE TABLE "company_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target_url" text NOT NULL,
	"secret" text NOT NULL,
	"event" text DEFAULT 'task.completed' NOT NULL,
	"filter_roles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"filter_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"filter_task_types" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_webhooks" ADD CONSTRAINT "company_webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_company_webhooks_company_event" ON "company_webhooks" USING btree ("company_id","event");