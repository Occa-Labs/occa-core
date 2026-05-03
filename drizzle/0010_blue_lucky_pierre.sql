DROP INDEX "uniq_company_skill_key";--> statement-breakpoint
ALTER TABLE "company_skills" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_builtin_skill_key" ON "company_skills" USING btree ("key") WHERE "company_skills"."company_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_company_skill_key" ON "company_skills" USING btree ("company_id","key") WHERE "company_skills"."company_id" IS NOT NULL;