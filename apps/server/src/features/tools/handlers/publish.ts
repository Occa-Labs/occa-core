// Publish handler — ships a finished deliverable to a configured receiver and
// returns its public URL. The receiver is any OCCA-compatible endpoint that
// accepts the standard task.completed payload (HMAC-signed) and answers with
// `{ url }` (e.g. a company's /api/publish).
//
// Two side benefits make this the cleanest publish UX for agents:
//   1. It resolves the calling agent's role so role-based receivers (those
//      that map role → section) route correctly with no extra input.
//   2. On success it records the returned URL on the agent's current task as
//      `result_uri`, so the on-chain trace links to the live work — the agent
//      doesn't need to emit a separate marker.
//
// Self-contained: reaches only its own deployment + its own running task, via
// infra `db` and shared schema (no cross-feature imports).

import crypto from "node:crypto";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  agentIdentities,
  deployments,
  tasks,
  traces,
} from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { LIMITS } from "../../../lib/limits";
import { deriveTitleFromContent } from "../../../lib/markdown-title";
import { saveDeliverableDocument } from "../../../services/auto-save-document";
import type { ToolHandler, ToolInvokeResult } from "../domain/types";

const log = childLogger("tools:handlers:publish");

const SIGNATURE_HEADER = "X-OCCA-Signature";
const EVENT_HEADER = "X-OCCA-Event";
const DELIVERY_HEADER = "X-OCCA-Delivery";
const EVENT = "task.completed";
const TIMEOUT_MS = 10_000;

const credentialsSchema = z.object({
  endpointUrl: z.string().trim().url().max(LIMITS.URL),
  secret: z.string().min(1).max(LIMITS.WEBHOOK_SECRET),
});
type PublishCredentials = z.infer<typeof credentialsSchema>;

const postInputSchema = z.object({
  // Optional: when omitted, the title is derived from the content's first
  // markdown heading. The engine is tool-agnostic and only carries `content`;
  // deriving a display title from the document being published is this tool's
  // own normalization, not workflow/engine logic.
  title: z.string().trim().min(1).max(LIMITS.TITLE).optional(),
  content: z.string().min(1),
  format: z.string().trim().max(LIMITS.TINY).optional(),
  tags: z.array(z.string().trim().min(1).max(LIMITS.TAG)).max(LIMITS.TAGS_MAX).optional(),
  // Optional hosted cover image URL — forwarded to the receiver, which decides
  // how to use it. Set by a workflow that ran an image step before publish.
  image_url: z.string().trim().url().max(LIMITS.URL).optional(),
});

const postOutputSchema = z.object({
  url: z.string().url(),
  // Optional: a receiver may return the tags it assigned to the published
  // piece (receivers commonly derive topic tags when the caller sends none).
  // Mirrored onto the saved deliverable so the memory coverage signal has real
  // topic tags. Receiver-agnostic — any receiver that fills this participates.
  tags: z.array(z.string()).optional(),
});

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

// The calling agent's identity (for role-based receiver routing). Falls back
// to neutral values when the deployment can't be resolved.
async function resolveAgent(
  deploymentId: string | null,
): Promise<{ name: string; role: string }> {
  if (!deploymentId) return { name: "Agent", role: "agent" };
  const [row] = await db
    .select({ name: agentIdentities.name, role: deployments.role })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  return { name: row?.name ?? "Agent", role: row?.role ?? "agent" };
}

// The task the agent is currently working on, via its running trace.
async function resolveCurrentTaskId(
  deploymentId: string | null,
): Promise<string | null> {
  if (!deploymentId) return null;
  const [row] = await db
    .select({ taskId: traces.taskId })
    .from(traces)
    .where(and(eq(traces.deploymentId, deploymentId), eq(traces.status, "running")))
    .orderBy(desc(traces.createdAt))
    .limit(1);
  return row?.taskId ?? null;
}

async function publishContent(
  creds: PublishCredentials,
  companyId: string,
  deploymentId: string | null,
  input: z.infer<typeof postInputSchema>,
): Promise<ToolInvokeResult> {
  const agent = await resolveAgent(deploymentId);
  const taskId = await resolveCurrentTaskId(deploymentId);
  const tags = input.tags ?? [];
  const format = input.format ?? "markdown";
  const title = input.title ?? deriveTitleFromContent(input.content);

  const payload = {
    event: EVENT,
    occurredAt: new Date().toISOString(),
    company: { id: companyId, name: "" },
    task: { id: taskId ?? "tool", title, tags },
    document: {
      title,
      content: input.content,
      format,
      tags,
      ...(input.image_url ? { image_url: input.image_url } : {}),
    },
    agent,
    delegatedBy: null,
    trace: { id: "tool" },
  };
  const body = JSON.stringify(payload);
  const signature = sign(body, creds.secret);

  let res: Response;
  try {
    res = await fetch(creds.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: `sha256=${signature}`,
        [EVENT_HEADER]: EVENT,
        [DELIVERY_HEADER]: crypto.randomUUID(),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      errorCode: "network_error",
      errorMessage: err instanceof Error ? err.message : "publish request failed",
    };
  }

  const text = await res.text().catch(() => "");
  if (res.status === 429) {
    return { ok: false, errorCode: "rate_limited", errorMessage: "Receiver rate limited.", rateLimited: true };
  }
  if (!res.ok) {
    return {
      ok: false,
      errorCode: `publish_${res.status}`,
      errorMessage: text.slice(0, 300) || `Receiver returned ${res.status}`,
    };
  }

  let url: string | null = null;
  let receiverTags: string[] = [];
  try {
    const parsed = JSON.parse(text) as { url?: unknown; tags?: unknown };
    if (typeof parsed.url === "string" && parsed.url.length > 0) url = parsed.url;
    if (Array.isArray(parsed.tags)) {
      receiverTags = parsed.tags
        .map((t) => String(t).trim())
        .filter((t) => t.length > 0);
    }
  } catch {
    /* receiver returned non-JSON */
  }
  if (!url) {
    return {
      ok: false,
      errorCode: "no_url_returned",
      errorMessage: "Receiver accepted the post but did not return a { url }.",
    };
  }

  // Record the published URL on the current task — it becomes the on-chain
  // trace's result_uri when the task completes. Best-effort: a failure here
  // doesn't undo the successful publish.
  if (taskId) {
    try {
      await db
        .update(tasks)
        .set({ resultUri: url, updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)));
    } catch (err) {
      log.error({ err, taskId }, "publish: failed to record result_uri on task");
    }
  }

  // Tags for the saved deliverable: prefer what the agent supplied; fall back
  // to what the receiver assigned (it often derives topic tags when the caller
  // sends none). Mirrors the receiver's own precedence so OCCA's coverage tags
  // match what actually published.
  const deliverableTags = tags.length > 0 ? tags : receiverTags;

  // Mirror the shipped piece into the documents store with its real headline
  // + topic tags — the canonical row the memory coverage signal reads. Saved
  // even when taskId is null (tool-only publish). Best-effort inside the
  // service; never blocks the successful publish.
  void saveDeliverableDocument({
    companyId,
    taskId,
    deploymentId,
    title,
    content: input.content,
    format,
    tags: deliverableTags,
    url,
  });

  return {
    ok: true,
    output: {
      url,
      ...(deliverableTags.length > 0 ? { tags: deliverableTags } : {}),
    },
    resultSummary: { url, taskId },
  };
}

export const publishHandler: ToolHandler = {
  type: "publish",
  displayName: "Publish",
  description:
    "Publish a finished deliverable and get back its public URL. The URL is recorded as the task's on-chain proof-of-work link.",
  credentialsSchema,
  credentialFields: [
    {
      name: "endpointUrl",
      type: "string",
      required: true,
      secret: false,
      description: "The receiver endpoint the deliverable is POSTed to. Must return { url }.",
    },
    {
      name: "secret",
      type: "string",
      required: true,
      secret: true,
      description: "Shared secret used to HMAC-sign the request.",
    },
  ],
  actions: {
    post: {
      name: "post",
      description: "Publish a deliverable (title + content) and return its public URL.",
      inputSchema: postInputSchema,
      outputSchema: postOutputSchema,
      invoke: async (ctx, input) => {
        const parsed = postInputSchema.safeParse(input);
        if (!parsed.success) {
          return { ok: false, errorCode: "invalid_input", errorMessage: parsed.error.message };
        }
        const creds = ctx.credentials as PublishCredentials;
        return publishContent(creds, ctx.companyId, ctx.deploymentId, parsed.data);
      },
    },
  },
  // A test ping: well-behaved receivers short-circuit task.id === "test" with
  // a 200 before doing any real work, so this confirms reachability + secret.
  testConnection: async ({ credentials }) => {
    const parsed = credentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, errorCode: "invalid_credentials_shape", errorMessage: parsed.error.message };
    }
    const payload = {
      event: EVENT,
      occurredAt: new Date().toISOString(),
      company: { id: "", name: "" },
      task: { id: "test", title: "OCCA publish test", tags: [] as string[] },
      document: { title: "OCCA publish test", content: "test", format: "markdown", tags: [] as string[] },
      agent: { name: "OCCA", role: "system" },
      delegatedBy: null,
      trace: { id: "test" },
    };
    const body = JSON.stringify(payload);
    const signature = sign(body, parsed.data.secret);
    try {
      const res = await fetch(parsed.data.endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SIGNATURE_HEADER]: `sha256=${signature}`,
          [EVENT_HEADER]: EVENT,
          [DELIVERY_HEADER]: crypto.randomUUID(),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ok: false, errorCode: `publish_${res.status}`, errorMessage: `Receiver returned ${res.status}` };
      }
      return { ok: true, detail: "Receiver reachable and signature accepted." };
    } catch (err) {
      return {
        ok: false,
        errorCode: "network_error",
        errorMessage: err instanceof Error ? err.message : "publish test failed",
      };
    }
  },
};
