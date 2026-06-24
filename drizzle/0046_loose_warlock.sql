ALTER TABLE "agent_runtime_profile" ADD COLUMN "task_rate_usdc" bigint;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "payout_mint" text DEFAULT '11111111111111111111111111111111' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "mint" text DEFAULT '11111111111111111111111111111111' NOT NULL;