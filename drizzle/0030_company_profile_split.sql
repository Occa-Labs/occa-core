-- Split bloated `companies` (38 columns) into:
--   - `companies` core lifecycle (12 columns: id, owner, name, kind, paused/kickoff state, timestamps)
--   - `company_profile` 1:1 sibling for brand / contact / crypto / audience metadata
--
-- Lifecycle-only ops (kickoff state, pause, dispatcher checks) hit `companies`
-- and skip the JOIN; the full company window pulls both via JOIN. Drops the
-- legacy `kickoff_meeting_task_id` column at the same time (the meeting flow
-- was archived in favor of inline kickoff).

CREATE TABLE IF NOT EXISTS "company_profile" (
  "company_id"        uuid PRIMARY KEY REFERENCES "companies"("id") ON DELETE CASCADE,

  "tagline"           text,
  "logo_url"          text,
  "niche"             text,
  "founded_at"        timestamp,

  "coverage_scope"    text,
  "coverage_excluded" text,
  "content_pillars"   text[]  NOT NULL DEFAULT '{}',
  "brand_voice"       text,
  "forbidden_words"   text[]  NOT NULL DEFAULT '{}',

  "mission"           text,
  "vision"            text,
  "target_audience"   text,
  "usps"              text[]  NOT NULL DEFAULT '{}',

  "core_offering"     text,
  "service_catalog"   text[]  NOT NULL DEFAULT '{}',

  "contact_email"     text,
  "sales_email"       text,
  "phone"             text,

  "website_url"       text,
  "blog_url"          text,
  "newsletter_url"    text,
  "docs_url"          text,
  "social_handles"    jsonb   NOT NULL DEFAULT '{}'::jsonb,

  "treasury_address"  text,
  "chains_covered"    text[]  NOT NULL DEFAULT '{}',

  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);

-- Backfill — copy every non-deleted company's profile data over. Use COALESCE
-- on array/jsonb columns in case the source row had a NULL value despite the
-- NOT NULL default (defensive; should be a no-op).
INSERT INTO "company_profile" (
  "company_id",
  "tagline", "logo_url", "niche", "founded_at",
  "coverage_scope", "coverage_excluded", "content_pillars", "brand_voice", "forbidden_words",
  "mission", "vision", "target_audience", "usps",
  "core_offering", "service_catalog",
  "contact_email", "sales_email", "phone",
  "website_url", "blog_url", "newsletter_url", "docs_url", "social_handles",
  "treasury_address", "chains_covered"
)
SELECT
  c."id",
  c."tagline", c."logo_url", c."niche", c."founded_at",
  c."coverage_scope", c."coverage_excluded",
  COALESCE(c."content_pillars", '{}'::text[]),
  c."brand_voice",
  COALESCE(c."forbidden_words", '{}'::text[]),
  c."mission", c."vision", c."target_audience",
  COALESCE(c."usps", '{}'::text[]),
  c."core_offering",
  COALESCE(c."service_catalog", '{}'::text[]),
  c."contact_email", c."sales_email", c."phone",
  c."website_url", c."blog_url", c."newsletter_url", c."docs_url",
  COALESCE(c."social_handles", '{}'::jsonb),
  c."treasury_address",
  COALESCE(c."chains_covered", '{}'::text[])
FROM "companies" c
ON CONFLICT ("company_id") DO NOTHING;

-- Drop the moved columns from `companies`. Wrapped in IF EXISTS for
-- re-runnability against a partially-migrated dev DB.
ALTER TABLE "companies"
  DROP COLUMN IF EXISTS "tagline",
  DROP COLUMN IF EXISTS "logo_url",
  DROP COLUMN IF EXISTS "niche",
  DROP COLUMN IF EXISTS "founded_at",
  DROP COLUMN IF EXISTS "coverage_scope",
  DROP COLUMN IF EXISTS "coverage_excluded",
  DROP COLUMN IF EXISTS "content_pillars",
  DROP COLUMN IF EXISTS "brand_voice",
  DROP COLUMN IF EXISTS "forbidden_words",
  DROP COLUMN IF EXISTS "mission",
  DROP COLUMN IF EXISTS "vision",
  DROP COLUMN IF EXISTS "target_audience",
  DROP COLUMN IF EXISTS "usps",
  DROP COLUMN IF EXISTS "core_offering",
  DROP COLUMN IF EXISTS "service_catalog",
  DROP COLUMN IF EXISTS "contact_email",
  DROP COLUMN IF EXISTS "sales_email",
  DROP COLUMN IF EXISTS "phone",
  DROP COLUMN IF EXISTS "website_url",
  DROP COLUMN IF EXISTS "blog_url",
  DROP COLUMN IF EXISTS "newsletter_url",
  DROP COLUMN IF EXISTS "docs_url",
  DROP COLUMN IF EXISTS "social_handles",
  DROP COLUMN IF EXISTS "treasury_address",
  DROP COLUMN IF EXISTS "chains_covered",
  -- Legacy from the archived kickoff-meeting flow.
  DROP COLUMN IF EXISTS "kickoff_meeting_task_id";
