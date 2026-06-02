ALTER TABLE "agent_runtime_profile" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment_workspace_files" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "deployment_index" DROP NOT NULL;