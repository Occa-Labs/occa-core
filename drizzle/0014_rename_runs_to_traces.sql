-- Rename the "run" taxonomy to "trace" across the execution lineage.
-- heartbeat_runs → traces, heartbeat_run_events → trace_events, plus every
-- *_run_id foreign-key-ish column. `routine_runs` stays (different sense of
-- "run" — it records cron firings, not agent execution traces), but its
-- coalesced_into_run_id column is repointed to `coalesced_into_trace_id`.

--> statement-breakpoint
ALTER TABLE "heartbeat_runs" RENAME TO "traces";--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" RENAME TO "trace_events";--> statement-breakpoint

-- Column renames
ALTER TABLE "trace_events" RENAME COLUMN "run_id" TO "trace_id";--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" RENAME COLUMN "run_id" TO "trace_id";--> statement-breakpoint
ALTER TABLE "agent_task_sessions" RENAME COLUMN "last_run_id" TO "last_trace_id";--> statement-breakpoint
ALTER TABLE "agent_runtime_state" RENAME COLUMN "last_run_id" TO "last_trace_id";--> statement-breakpoint
ALTER TABLE "agent_runtime_state" RENAME COLUMN "last_run_status" TO "last_trace_status";--> statement-breakpoint
ALTER TABLE "traces" RENAME COLUMN "retry_of_run_id" TO "retry_of_trace_id";--> statement-breakpoint
ALTER TABLE "traces" RENAME COLUMN "external_run_id" TO "external_trace_id";--> statement-breakpoint
ALTER TABLE "routine_runs" RENAME COLUMN "coalesced_into_run_id" TO "coalesced_into_trace_id";--> statement-breakpoint

-- Index renames (match new table names)
ALTER INDEX "heartbeat_runs_company_agent_started_idx" RENAME TO "traces_company_agent_started_idx";--> statement-breakpoint
ALTER INDEX "heartbeat_runs_company_liveness_idx" RENAME TO "traces_company_liveness_idx";--> statement-breakpoint
ALTER INDEX "heartbeat_runs_status_created_idx" RENAME TO "traces_status_created_idx";--> statement-breakpoint
ALTER INDEX "heartbeat_run_events_run_seq_idx" RENAME TO "trace_events_trace_seq_idx";--> statement-breakpoint
ALTER INDEX "heartbeat_run_events_company_run_idx" RENAME TO "trace_events_company_trace_idx";--> statement-breakpoint
ALTER INDEX "heartbeat_run_events_company_created_idx" RENAME TO "trace_events_company_created_idx";--> statement-breakpoint

-- FK constraint renames (for hygiene; PG keeps FK working regardless of name)
ALTER TABLE "trace_events" RENAME CONSTRAINT "heartbeat_run_events_company_id_companies_id_fk" TO "trace_events_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "trace_events" RENAME CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk" TO "trace_events_trace_id_traces_id_fk";--> statement-breakpoint
ALTER TABLE "trace_events" RENAME CONSTRAINT "heartbeat_run_events_agent_id_agents_id_fk" TO "trace_events_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "traces" RENAME CONSTRAINT "heartbeat_runs_company_id_companies_id_fk" TO "traces_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "traces" RENAME CONSTRAINT "heartbeat_runs_agent_id_agents_id_fk" TO "traces_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "traces" RENAME CONSTRAINT "heartbeat_runs_wakeup_request_id_agent_wakeup_requests_id_fk" TO "traces_wakeup_request_id_agent_wakeup_requests_id_fk";--> statement-breakpoint
ALTER TABLE "traces" RENAME CONSTRAINT "heartbeat_runs_retry_of_run_id_heartbeat_runs_id_fk" TO "traces_retry_of_trace_id_traces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_task_sessions" RENAME CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk" TO "agent_task_sessions_last_trace_id_traces_id_fk";--> statement-breakpoint

-- JSONB data migration: agent_result blocks inside tasks.blocks carry a
-- `runId` field. Rename to `traceId` so the schema and in-row shape line up.
UPDATE "tasks"
SET "blocks" = (
  SELECT jsonb_agg(
    CASE
      WHEN block->>'type' = 'agent_result' AND block ? 'runId'
        THEN jsonb_set(block - 'runId', '{traceId}', block->'runId')
      ELSE block
    END
  )
  FROM jsonb_array_elements("blocks") AS block
)
WHERE "blocks" @> '[{"type":"agent_result"}]';
