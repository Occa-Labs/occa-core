ALTER TABLE "traces" ADD COLUMN IF NOT EXISTS "conversation_id" text;
CREATE INDEX IF NOT EXISTS "traces_conversation_id_idx" ON "traces" ("conversation_id");
