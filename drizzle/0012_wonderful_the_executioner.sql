CREATE TABLE "episodic_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text DEFAULT 'story_published' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"salience" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "episodic_memory" ADD CONSTRAINT "episodic_memory_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_episodic_memory_company_occurred" ON "episodic_memory" USING btree ("company_id","occurred_at");