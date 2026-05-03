-- Add full identity / brand / contact / presence / state fields to companies.
-- Powers the new Company window (CRUD + pause/resume) and gives every agent
-- a richer baseline context (mission, brand voice, coverage scope, etc).

ALTER TABLE "companies"
  -- Identity / branding
  ADD COLUMN IF NOT EXISTS "tagline"           text,
  ADD COLUMN IF NOT EXISTS "logo_url"          text,
  ADD COLUMN IF NOT EXISTS "niche"             text,
  ADD COLUMN IF NOT EXISTS "founded_at"        timestamp,

  -- Editorial identity (Crypto Content & Research Studio core)
  ADD COLUMN IF NOT EXISTS "coverage_scope"    text,
  ADD COLUMN IF NOT EXISTS "coverage_excluded" text,
  ADD COLUMN IF NOT EXISTS "content_pillars"   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "brand_voice"       text,
  ADD COLUMN IF NOT EXISTS "forbidden_words"   text[] NOT NULL DEFAULT '{}',

  -- Mission & audience
  ADD COLUMN IF NOT EXISTS "mission"           text,
  ADD COLUMN IF NOT EXISTS "vision"            text,
  ADD COLUMN IF NOT EXISTS "target_audience"   text,
  ADD COLUMN IF NOT EXISTS "usps"              text[] NOT NULL DEFAULT '{}',

  -- Output / services
  ADD COLUMN IF NOT EXISTS "core_offering"     text,
  ADD COLUMN IF NOT EXISTS "service_catalog"   text[] NOT NULL DEFAULT '{}',

  -- Contact
  ADD COLUMN IF NOT EXISTS "contact_email"     text,
  ADD COLUMN IF NOT EXISTS "sales_email"       text,
  ADD COLUMN IF NOT EXISTS "phone"             text,

  -- Presence (web + social)
  ADD COLUMN IF NOT EXISTS "website_url"       text,
  ADD COLUMN IF NOT EXISTS "blog_url"          text,
  ADD COLUMN IF NOT EXISTS "newsletter_url"    text,
  ADD COLUMN IF NOT EXISTS "docs_url"          text,
  ADD COLUMN IF NOT EXISTS "social_handles"    jsonb  NOT NULL DEFAULT '{}'::jsonb,

  -- Crypto-native
  ADD COLUMN IF NOT EXISTS "treasury_address"  text,
  ADD COLUMN IF NOT EXISTS "chains_covered"    text[] NOT NULL DEFAULT '{}',

  -- State (pakum / paused — distinct from deletion)
  ADD COLUMN IF NOT EXISTS "paused_at"         timestamptz,
  ADD COLUMN IF NOT EXISTS "paused_reason"     text;
