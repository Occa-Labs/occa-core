-- Stable 3D office anchor ID per agent. Assigned once at hire time by
-- the seating service (@occa/shared/seating + apps/server/.../seat-assignment.ts)
-- and never updated. Frontend looks this up against office-anchors.ts to
-- place each avatar; legacy rows pre-migration carry NULL and fall back
-- to a deterministic role-based pick on the client.
--
-- The partial unique index enforces "one agent per desk per company" but
-- allows arbitrarily many NULLs (legacy rows + the brief window between
-- INSERT and the seat-stamp on first hire).

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "workstation_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_agents_company_workstation"
  ON "agents" ("company_id", "workstation_id")
  WHERE "workstation_id" IS NOT NULL;
