"use client";

// Deliverable journey — the post-completion lifecycle of one task's
// deliverable, projected onto five stages: written → verified → published →
// anchored → reputation. It reads from data that already exists, so it works
// retroactively for tasks anchored before this view shipped:
//   - written / verified : task_events (agent_trace_finished, VerificationPassed)
//   - published / anchored: the matching on-chain TraceAnchor (resultUri, hash)
//   - reputation         : derived from the anchor (the score it contributes)
//
// The anchor is matched to this task by recomputing the deterministic on-chain
// task_id — sha256(`${companyId}:${taskId}`) — client-side and comparing it to
// each TraceAnchor's `taskId` (see commit-trace-engine.deriveTaskIdBytes).

import { useEffect, useState, type ComponentType } from "react";
import {
  Anchor,
  Award,
  ExternalLink,
  Globe,
  PenLine,
  ShieldCheck,
} from "lucide-react";
import type { TaskDTO, TaskEventDTO } from "@occa/shared/types";
import type { TraceAnchorRecord } from "@/lib/api";
import { explorerAddressUrl } from "@/lib/solana-explorer";
import { useCompanyTraceAnchors } from "../api/use-task-trace-anchor";

type StageState = "done" | "pending" | "failed" | "private";

interface Stage {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  state: StageState;
  detail?: string;
  href?: string;
  hrefLabel?: string;
}

export function DeliverableJourney({
  task,
  events,
}: {
  task: TaskDTO;
  events: TaskEventDTO[];
}) {
  const verifiedPass = events.find(
    (e) =>
      e.eventType === "agent_action_emitted" &&
      e.payload.actionType === "VerificationPassed",
  );
  const verifiedFail = events.find(
    (e) =>
      e.eventType === "agent_action_emitted" &&
      e.payload.actionType === "VerificationFailed",
  );
  const traceFinished = [...events]
    .reverse()
    .find((e) => e.eventType === "agent_trace_finished");

  // The journey is about an agent's deliverable — only surface it once an
  // agent has actually produced or verified something. A hand-completed task
  // with no agent run never shows it.
  const show = !!verifiedPass || !!verifiedFail || !!traceFinished;

  // Hooks run unconditionally; `enabled` gates the network + work.
  const anchors = useCompanyTraceAnchors(task.companyId, show);
  const derivedTaskId = useDerivedTaskId(task.companyId, task.id, show);

  const trace =
    derivedTaskId && anchors.data
      ? anchors.data.traces.find((t) => t.taskId === derivedTaskId)
      : undefined;

  if (!show) return null;

  const stages = buildStages({
    verifiedPass,
    verifiedFail,
    trace,
    anchorsLoading: anchors.isLoading,
  });

  return (
    <>
      <hr className="border-white/8" />
      <div className="space-y-2.5">
        <div className="text-[10px] uppercase tracking-wider text-white/45">
          Deliverable journey
        </div>
        <ol className="relative space-y-3 pl-1">
          <span
            aria-hidden
            className="absolute left-[11px] top-3 bottom-3 w-px bg-white/8"
          />
          {stages.map((stage) => (
            <StageRow key={stage.key} stage={stage} />
          ))}
        </ol>
      </div>
    </>
  );
}

function StageRow({ stage }: { stage: Stage }) {
  const Icon = stage.icon;
  return (
    <li className="relative flex items-start gap-2.5">
      <span
        className={`relative z-10 flex size-[22px] shrink-0 items-center justify-center rounded-full border ${nodeClass(stage.state)}`}
      >
        <Icon className="size-3" />
      </span>
      <div className="min-w-0 pt-0.5">
        <span className={`text-xs ${labelClass(stage.state)}`}>
          {stage.label}
        </span>
        {stage.detail && (
          <p className="mt-0.5 text-[11px] text-white/40 truncate">
            {stage.detail}
          </p>
        )}
        {stage.href && (
          <a
            href={stage.href}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-sky-300/80 hover:text-sky-200 transition-colors"
          >
            {stage.hrefLabel ?? "Open"}
            <ExternalLink className="size-2.5" />
          </a>
        )}
      </div>
    </li>
  );
}

function buildStages({
  verifiedPass,
  verifiedFail,
  trace,
  anchorsLoading,
}: {
  verifiedPass?: TaskEventDTO;
  verifiedFail?: TaskEventDTO;
  trace?: TraceAnchorRecord;
  anchorsLoading: boolean;
}): Stage[] {
  const verifiedOk = !!verifiedPass;
  const score =
    typeof verifiedPass?.payload.qualityScore === "number"
      ? (verifiedPass.payload.qualityScore as number)
      : trace?.qualityScore;
  // Once anchored, downstream stages are settled; before that they read as
  // pending (or actively "reading chain" while the lookup is in flight).
  const pendingDetail = (active: boolean): string | undefined =>
    !verifiedOk ? undefined : active && anchorsLoading ? "Reading chain…" : "Pending";

  const written: Stage = {
    key: "written",
    label: "Deliverable written",
    icon: PenLine,
    state: verifiedPass || verifiedFail || trace ? "done" : "pending",
  };

  let verified: Stage;
  if (verifiedPass) {
    verified = {
      key: "verified",
      label: "Passed verification",
      icon: ShieldCheck,
      state: "done",
      detail: typeof score === "number" ? `Quality score ${score}` : undefined,
    };
  } else if (verifiedFail) {
    verified = {
      key: "verified",
      label: "Failed verification",
      icon: ShieldCheck,
      state: "failed",
      detail:
        typeof verifiedFail.payload.reason === "string"
          ? (verifiedFail.payload.reason as string)
          : undefined,
    };
  } else {
    verified = {
      key: "verified",
      label: "Awaiting verification",
      icon: ShieldCheck,
      state: "pending",
    };
  }

  let published: Stage;
  if (trace && trace.resultUri) {
    published = {
      key: "published",
      label: "Published",
      icon: Globe,
      state: "done",
      href: trace.resultUri,
      hrefLabel: "View live deliverable",
    };
  } else if (trace) {
    published = {
      key: "published",
      label: "Kept private",
      icon: Globe,
      state: "private",
      detail: "No public URL — hash only",
    };
  } else {
    published = {
      key: "published",
      label: "Publish",
      icon: Globe,
      state: "pending",
      detail: pendingDetail(true),
    };
  }

  const anchored: Stage = trace
    ? {
        key: "anchored",
        label: "Anchored on-chain",
        icon: Anchor,
        state: "done",
        detail: `${trace.contentHash.slice(0, 8)}…${trace.contentHash.slice(-6)}`,
        href: explorerAddressUrl(trace.pda),
        hrefLabel: "View trace on explorer",
      }
    : {
        key: "anchored",
        label: "Anchor on-chain",
        icon: Anchor,
        state: "pending",
        detail: pendingDetail(true),
      };

  const reputation: Stage = trace
    ? {
        key: "reputation",
        label: "Counted toward reputation",
        icon: Award,
        state: "done",
        detail: trace.agentName
          ? `Adds to ${trace.agentName}'s on-chain record`
          : "Adds to the agent's on-chain record",
      }
    : {
        key: "reputation",
        label: "Reputation",
        icon: Award,
        state: "pending",
        detail: pendingDetail(false),
      };

  return [written, verified, published, anchored, reputation];
}

function nodeClass(state: StageState): string {
  switch (state) {
    case "done":
      return "border-emerald-400/30 bg-emerald-400/15 text-emerald-300";
    case "failed":
      return "border-red-400/30 bg-red-400/12 text-red-300";
    case "private":
      return "border-white/15 bg-white/8 text-white/45";
    case "pending":
      return "border-white/10 bg-white/5 text-white/25";
  }
}

function labelClass(state: StageState): string {
  switch (state) {
    case "done":
      return "text-white/80";
    case "failed":
      return "text-red-300";
    case "private":
      return "text-white/55";
    case "pending":
      return "text-white/35";
  }
}

// Recompute the deterministic on-chain task_id off the main thread via
// Web Crypto. Matches commit-trace-engine.deriveTaskIdBytes byte-for-byte:
// sha256(utf8(`${companyId}:${taskId}`)), hex-encoded.
function useDerivedTaskId(
  companyId: string,
  taskId: string,
  enabled: boolean,
): string | null {
  const [hex, setHex] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const bytes = new TextEncoder().encode(`${companyId}:${taskId}`);
    void crypto.subtle.digest("SHA-256", bytes).then((buf) => {
      if (cancelled) return;
      setHex(
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, taskId, enabled]);
  return hex;
}
