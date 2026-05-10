// Builds the wake-prompt sent to the agent (CEO) when the user sends a
// chat turn. Mirror of `features/tasks/services/prompt-builder.ts:buildTaskPrompt`
// but for the chat surface (Surface 1 in CEO's AGENTS.md):
//   • Identity preamble — agent doesn't auto-discover its name/role from
//     the workspace, so we state it once at the start of a session.
//     Cheap insurance against the "Who am I?" failure mode.
//   • User identity — tells the agent who it is talking TO (the company
//     owner / founder). Per OCCA's "1 wallet = 1 user = 1 company" MVP
//     invariant, the chat counterpart is always the owner — never an
//     employee, customer, or stranger.
//   • Mode framing — explicitly tell the agent it's in chat (not task),
//     the rules from AGENTS.md Surface 1 (clarify → CONFIRM → emit
//     CREATE_TASK), and the marker syntax to use. Confirmation is a
//     hard requirement: marker only emits AFTER the user explicitly
//     agrees in a reply turn.
//   • Workspace pointer — the agent has BOOTSTRAP.md / IDENTITY.md /
//     AGENTS.md / SOUL.md seeded on its filesystem; tell it to read them
//     for the full persona context.
//
// Note on token economics: this preamble is heavy (~30 lines) so we send
// it ONLY on the first turn of a session. The gateway preserves history
// per sessionKey, so subsequent turns inherit the preamble's context for
// free — we send raw user content. After the user clears the thread
// (sessionKey suffix rotates), the preamble re-injects on the next first
// turn. See `chat-handler.ts:isFirstTurn` for the gate.

import { eq } from "drizzle-orm";
import { roleLabelFor } from "@occa/shared/role-catalog";
import { agentIdentities, companies, deployments } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export interface ChatPromptContext {
  agentName: string;
  agentRole: string;
  agentRoleLabel: string;
  companyName: string;
}

export async function loadChatPromptContext(
  deploymentId: string,
): Promise<ChatPromptContext | null> {
  const [row] = await db
    .select({
      agentName: agentIdentities.name,
      agentRole: deployments.role,
      companyName: companies.name,
    })
    .from(deployments)
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .innerJoin(companies, eq(deployments.companyId, companies.id))
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!row) return null;
  return {
    agentName: row.agentName,
    agentRole: row.agentRole,
    agentRoleLabel: roleLabelFor(row.agentRole),
    companyName: row.companyName,
  };
}

export function buildChatPrompt(
  ctx: ChatPromptContext,
  userMessage: string,
): string {
  // Conversational roleplay framing — no XML tags, lead with identity
  // assertion + explicit "begin your reply with" instruction. Empirically
  // Claude (Sonnet 4.6) ignores XML-wrapped `<occa-runtime>` rule blocks
  // in user messages and defaults to a generic "I just came online —
  // who am I?" intro, even when identity is stated. Roleplay setup
  // ("You are X. Owner says: ...") locks in persona reliably.
  return [
    `You are ${ctx.agentName}, the ${ctx.agentRoleLabel} of ${ctx.companyName} — an AI agent running inside OCCA OS.`,
    ``,
    `Your full persona lives in your workspace files (./SOUL.md, ./AGENTS.md, ./IDENTITY.md, ./HEARTBEAT.md). Read them if you haven't this session.`,
    ``,
    `You are talking to the OWNER / FOUNDER of ${ctx.companyName} — your principal. They built this company and you report directly to them. Treat their messages as principal-from-board direction, not customer support tickets.`,
    ``,
    `HOW TO REPLY:`,
    `- BEGIN your very first reply by acknowledging your identity in your own persona voice (e.g. "Hey — ${ctx.agentName} here." or similar). DO NOT ask "who am I" or "who are you" — you already know.`,
    `- Use your CEO voice from ./SOUL.md: direct, action-oriented, no corporate warm-up, no exclamation points unless something is on fire.`,
    `- For ambiguous requests, ask 1-2 sharp clarifying questions. Multi-turn dialogue is normal and expected.`,
    `- BEFORE creating a task: once scope feels clear, RESTATE it back in plain language and ask the owner explicitly — "Want me to kick this off?" or "OK to start?". DO NOT emit CREATE_TASK in the same reply where you propose the scope.`,
    `- ONLY after the owner explicitly confirms ("yes", "go", "do it", "proceed") do you emit CREATE_TASK — and the marker goes in the SAME reply that acknowledges the green light.`,
    `- If the owner declines or wants changes, keep refining via dialogue.`,
    ``,
    `CREATE_TASK MARKER (emit only after explicit owner confirmation):`,
    ``,
    `[[OCCA:CREATE_TASK]]`,
    `{`,
    `  "title": "<short imperative summary>",`,
    `  "brief": "<full agreed scope: deliverable, audience, deadline, constraints>",`,
    `  "tags": ["optional"],`,
    `  "priority": "low" | "medium" | "high"`,
    `}`,
    `[[/OCCA:CREATE_TASK]]`,
    ``,
    `Body must be valid JSON. One marker per reply max. The runtime parses + strips the marker from the owner's view, so your surrounding prose is what they read. Never paste this syntax outside an actual emit.`,
    ``,
    `---`,
    ``,
    `Owner says:`,
    userMessage,
  ].join("\n");
}
