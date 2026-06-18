// Single source of truth for the CEO's chat-emitted OS-mutation actions.
//
// Before this registry the dispatch lived as a hand-maintained `switch
// (block.token)` in features/chat (autonomous path), a parallel `switch
// (actionType)` in features/approvals (with-approval path), AND a third
// hand-kept block of marker usage docs in services/memory/render/chat.
// Adding one action meant editing all three plus the prompt spec.
//
// The registry collapses token -> {tier, handler, prompt spec} into one
// table. Each descriptor declares:
//   - tier:       "autonomous" runs immediately; "with_approval" lands in
//                 the Approvals queue and the operator commits it. This is
//                 the authority model the operating-a-company doc is built
//                 on.
//   - run:        the side-effect handler (referenced as-is from handlers).
//   - promptSpec: the marker usage block the CEO sees in its first-turn
//                 prompt. render/chat.ts assembles the marker section by
//                 iterating this table, so a new action shows up to the CEO
//                 the moment its descriptor lands here — no separate prompt
//                 edit.
//
// This file moves NO execution logic out of handlers.ts. The promptSpec
// strings are the verbatim blocks that previously lived inline in
// render/chat.ts; they reference catalog sections ("YOUR ACTIVE TEAM
// above", etc.) that render/chat.ts emits elsewhere in the same prompt.

import type { ActionBlockHandlerArgs } from "./handlers";
import {
  applyKnowledgeEditApproval,
  applyProfileEditApproval,
  applyRoutineEditApproval,
  applySkillLibraryEditApproval,
  applyTaskDeleteApproval,
  applyRoutineCreateApproval,
  applyToolEditApproval,
  applyWorkflowCreateApproval,
  applyWorkflowDeleteApproval,
  applyWorkflowEditApproval,
  handleAssignRoutineBlock,
  handleBindToolBlock,
  handleDispatchRoutineBlock,
  handleInstallSkillBlock,
  handleProposeDeploymentBlock,
  handleProposeKnowledgeEditBlock,
  handleProposeProfileEditBlock,
  handleProposeRoutineCreateBlock,
  handleProposeRoutineEditBlock,
  handleProposeSkillLibraryEditBlock,
  handleProposeTaskDeleteBlock,
  handleProposeToolEditBlock,
  handleCommentTaskBlock,
  handleEditTaskBlock,
  handleProposeWorkflowCreateBlock,
  handleProposeWorkflowDeleteBlock,
  handleProposeWorkflowEditBlock,
  handleSetTaskStatusBlock,
  handleToggleChannelBlock,
  handleToggleRoutineBlock,
  handleToggleWorkflowBlock,
  handleUnbindToolBlock,
  handleUninstallSkillBlock,
} from "./handlers";
import type { ActionBlockOutcome } from "./schemas";
import { approvals } from "@occa/shared/schema";

type ApprovalRow = typeof approvals.$inferSelect;

export type CeoActionTier = "autonomous" | "with_approval";

export interface CeoActionDescriptor {
  token: string;
  tier: CeoActionTier;
  // Runs the marker. For autonomous actions this IS the mutation. For
  // with-approval actions it drafts the pending approvals row (it never
  // mutates the target).
  run: (args: ActionBlockHandlerArgs) => Promise<ActionBlockOutcome>;
  // Marker usage block shown to the CEO in its prompt. References catalog
  // sections rendered elsewhere in the prompt. No value interpolation.
  promptSpec: string;
  // with_approval only: the value the handler writes to approvals.actionType.
  // The approval side-effect dispatcher maps an approval row back to its
  // descriptor by this string.
  approvalActionType?: string;
  // with_approval only: applied when the operator approves the row. Absent
  // for actions the operator commits some other way (PROPOSE_DEPLOYMENT is
  // finished by the operator-signed deploy modal, so approve is a no-op).
  executeOnApprove?: (approval: ApprovalRow) => Promise<ApprovalRow>;
}

// Keyed by marker token. Iteration order = the order the marker specs
// appear in the CEO prompt, so it is intentional, not incidental.
export const CEO_ACTIONS: Record<string, CeoActionDescriptor> = {
  INSTALL_SKILL: {
    token: "INSTALL_SKILL",
    tier: "autonomous",
    run: handleInstallSkillBlock,
    promptSpec: [
      `INSTALL_SKILL MARKER (use when the owner asks to install a skill on an agent):`,
      `- Look up the target agent's deployment uuid from YOUR ACTIVE TEAM above (or use your own id if installing on yourself).`,
      `- Look up the exact skill key from INSTALLABLE SKILL CATALOG above. Do NOT invent keys — if the catalog is empty for the owner's request, say so and stop.`,
      `- Respect each skill's allowedRoles: only suggest or install a skill on an agent whose role is in that skill's allowedRoles. allowedRoles '(any)' means no restriction. Do NOT offer a skill the target's role isn't allowed — it will be rejected.`,
      `- One marker per (agent, skill). Multiple markers per reply are allowed when the owner asks for several installs at once.`,
      `- This is auto-executed. Do not ask for confirmation. Do not write a fake "✓" in your prose — the runtime appends the receipt automatically.`,
      `- Skill activates on the target agent's NEXT task, not retroactively.`,
      ``,
      `[[OCCA:INSTALL_SKILL]]`,
      `{`,
      `  "deploymentId": "<deployment uuid from YOUR ACTIVE TEAM above>",`,
      `  "skillKey": "<key from INSTALLABLE SKILL CATALOG above>"`,
      `}`,
      `[[/OCCA:INSTALL_SKILL]]`,
    ].join("\n"),
  },
  UNINSTALL_SKILL: {
    token: "UNINSTALL_SKILL",
    tier: "autonomous",
    run: handleUninstallSkillBlock,
    promptSpec: [
      `UNINSTALL_SKILL MARKER (use when the owner asks to remove a skill from an agent):`,
      `- Same shape as INSTALL_SKILL. Look up the deployment uuid from YOUR ACTIVE TEAM and use the exact skill key from the INSTALLED SKILLS PER AGENT list above.`,
      `- Auto-executed, idempotent — if the key isn't on the agent the runtime returns a "wasn't installed" ack with no error.`,
      `- Removal takes effect on the target agent's NEXT task.`,
      ``,
      `[[OCCA:UNINSTALL_SKILL]]`,
      `{`,
      `  "deploymentId": "<deployment uuid from YOUR ACTIVE TEAM above>",`,
      `  "skillKey": "<key currently installed on that deployment>"`,
      `}`,
      `[[/OCCA:UNINSTALL_SKILL]]`,
    ].join("\n"),
  },
  BIND_TOOL: {
    token: "BIND_TOOL",
    tier: "autonomous",
    run: handleBindToolBlock,
    promptSpec: [
      `BIND_TOOL MARKER (use when the owner asks to give an agent access to a tool):`,
      `- Look up the target agent's deployment uuid from YOUR ACTIVE TEAM above.`,
      `- Look up the tool UUID ('id') from BINDABLE TOOL CATALOG above. NEVER invent UUIDs — if the catalog is empty for the owner's request, say so and stop.`,
      `- One marker per (agent, tool). Multiple markers per reply are allowed.`,
      `- Auto-executed. Tool becomes available to the agent on its NEXT task.`,
      `- Tool credentials are NOT set via this marker — operator configures them in the Tools window. You can only bind tools that are already provisioned.`,
      ``,
      `[[OCCA:BIND_TOOL]]`,
      `{`,
      `  "deploymentId": "<deployment uuid from YOUR ACTIVE TEAM above>",`,
      `  "toolId": "<id from BINDABLE TOOL CATALOG above>"`,
      `}`,
      `[[/OCCA:BIND_TOOL]]`,
    ].join("\n"),
  },
  UNBIND_TOOL: {
    token: "UNBIND_TOOL",
    tier: "autonomous",
    run: handleUnbindToolBlock,
    promptSpec: [
      `UNBIND_TOOL MARKER (use when the owner asks to remove a tool from an agent):`,
      `- Same shape as BIND_TOOL. Use the tool UUID from BOUND TOOLS PER AGENT list above.`,
      `- Auto-executed, idempotent.`,
      ``,
      `[[OCCA:UNBIND_TOOL]]`,
      `{`,
      `  "deploymentId": "<deployment uuid from YOUR ACTIVE TEAM above>",`,
      `  "toolId": "<id currently bound to that deployment>"`,
      `}`,
      `[[/OCCA:UNBIND_TOOL]]`,
    ].join("\n"),
  },
  TOGGLE_CHANNEL: {
    token: "TOGGLE_CHANNEL",
    tier: "autonomous",
    run: handleToggleChannelBlock,
    promptSpec: [
      `TOGGLE_CHANNEL MARKER (use when the owner asks to turn a channel on or off):`,
      `- Use the channelType string from YOUR CHANNELS above (e.g. "telegram").`,
      `- 'enabled: true' turns the channel back on, 'enabled: false' silences it. Credentials stay intact either way — operator can toggle back without re-setting up.`,
      `- Auto-executed, idempotent (re-emitting the same value just re-confirms).`,
      `- If the channel is NOT in YOUR CHANNELS yet, do NOT emit. Tell the owner they need to connect it from the Channels window first; credentials are never set via chat.`,
      ``,
      `[[OCCA:TOGGLE_CHANNEL]]`,
      `{`,
      `  "channelType": "<channelType from YOUR CHANNELS above>",`,
      `  "enabled": true | false`,
      `}`,
      `[[/OCCA:TOGGLE_CHANNEL]]`,
    ].join("\n"),
  },
  TOGGLE_WORKFLOW: {
    token: "TOGGLE_WORKFLOW",
    tier: "autonomous",
    run: handleToggleWorkflowBlock,
    promptSpec: [
      `TOGGLE_WORKFLOW MARKER (use when the owner asks to enable or pause a workflow):`,
      `- Use the workflow yamlId from COMPANY WORKFLOWS above.`,
      `- 'enabled: true' resumes the workflow, 'enabled: false' pauses it. YAML definition stays intact — operator can resume without re-defining.`,
      `- Auto-executed, idempotent.`,
      `- If yamlId is NOT in COMPANY WORKFLOWS, do NOT emit. Tell the owner the workflow doesn't exist yet — they need to create it from the Workflows window.`,
      ``,
      `[[OCCA:TOGGLE_WORKFLOW]]`,
      `{`,
      `  "workflowYamlId": "<yamlId from COMPANY WORKFLOWS above>",`,
      `  "enabled": true | false`,
      `}`,
      `[[/OCCA:TOGGLE_WORKFLOW]]`,
    ].join("\n"),
  },
  TOGGLE_ROUTINE: {
    token: "TOGGLE_ROUTINE",
    tier: "autonomous",
    run: handleToggleRoutineBlock,
    promptSpec: [
      `TOGGLE_ROUTINE MARKER (use when the owner asks to pause or resume a routine):`,
      `- Use the routine id (UUID) from COMPANY ROUTINES above. Routines have no slug; the UUID is the address.`,
      `- 'active: true' resumes, 'active: false' pauses. Triggers and assignee stay intact — only the routine status flips.`,
      `- Auto-executed, idempotent.`,
      `- Archived routines cannot be flipped from chat; tell the owner to restore from the Routines window first.`,
      ``,
      `[[OCCA:TOGGLE_ROUTINE]]`,
      `{`,
      `  "routineId": "<id from COMPANY ROUTINES above>",`,
      `  "active": true | false`,
      `}`,
      `[[/OCCA:TOGGLE_ROUTINE]]`,
    ].join("\n"),
  },
  DISPATCH_ROUTINE: {
    token: "DISPATCH_ROUTINE",
    tier: "autonomous",
    run: handleDispatchRoutineBlock,
    promptSpec: [
      `DISPATCH_ROUTINE MARKER (use when the owner asks to FIRE a routine NOW, ahead of its schedule):`,
      `- This is CONFIRM-TIER. Follow CONFIRM + EMIT FLOW above: restate what you'd run, ask "Want me to fire it now?", and ONLY emit once the owner says yes/go/proceed.`,
      `- Routine must already be active and have an assignee. Paused/archived routines must be resumed first; unassigned routines need an assignee in the Routines window.`,
      `- A wrapper task is created and the assignee wakes up immediately to execute. Production impact — agent run consumes resources.`,
      `- The runtime de-dupes manual dispatches within a 5-minute window. If you ask twice quickly, the second one is rejected as already_running.`,
      ``,
      `[[OCCA:DISPATCH_ROUTINE]]`,
      `{`,
      `  "routineId": "<id from COMPANY ROUTINES above>"`,
      `}`,
      `[[/OCCA:DISPATCH_ROUTINE]]`,
    ].join("\n"),
  },
  ASSIGN_ROUTINE: {
    token: "ASSIGN_ROUTINE",
    tier: "autonomous",
    run: handleAssignRoutineBlock,
    promptSpec: [
      `ASSIGN_ROUTINE MARKER (use when the owner asks to change who runs a routine):`,
      `- Use the routine id (UUID) from COMPANY ROUTINES above, and the deployment uuid of the new assignee from YOUR ACTIVE TEAM above.`,
      `- Pass 'assigneeDeploymentId: null' to clear the assignee — the routine effectively pauses on next firing.`,
      `- Auto-executed, idempotent. In-flight wrapper tasks already dispatched stay with their current assignee; only future firings move.`,
      ``,
      `[[OCCA:ASSIGN_ROUTINE]]`,
      `{`,
      `  "routineId": "<id from COMPANY ROUTINES above>",`,
      `  "assigneeDeploymentId": "<deployment uuid from YOUR ACTIVE TEAM, or null>"`,
      `}`,
      `[[/OCCA:ASSIGN_ROUTINE]]`,
    ].join("\n"),
  },
  PROPOSE_DEPLOYMENT: {
    token: "PROPOSE_DEPLOYMENT",
    tier: "with_approval",
    approvalActionType: "propose_deployment",
    // No executeOnApprove: the operator finishes a deployment proposal in
    // the deploy modal (enters the gateway token + signs). Approve only
    // closes the row; it never provisions.
    run: handleProposeDeploymentBlock,
    promptSpec: [
      `PROPOSE_DEPLOYMENT MARKER (use when the owner asks to add / deploy a new agent):`,
      `- This does NOT deploy. It creates a PROPOSAL the owner opens in the Approvals window ("Deploy this"), where THEY enter the gateway endpoint + token and sign. Nothing is provisioned from chat.`,
      `- You NEVER supply a gateway URL, an API key / token, or a signature — those are operator-only, entered in the OS. If the owner pastes a token in chat, refuse it and tell them to enter it in the deploy modal.`,
      `- 'role' MUST be a key from PROPOSABLE ROLES above. 'runtime' MUST be one from PROPOSABLE RUNTIMES above. Do NOT invent either — if what the owner wants isn't in the catalog, say so and stop.`,
      `- 'skills' is optional: keys from INSTALLABLE SKILL CATALOG above that the proposed role is allowed to use. Omit or pass [] if unsure.`,
      `- 'suggestedName' MUST be a realistic HUMAN persona name in the same style as YOUR ACTIVE TEAM above (a first + last name like "Noa Reinhardt" or a single given name like "Juno") — NEVER the role title or a job label like "On-chain Analyst". Invent a fresh name that isn't already on the team. The owner can rename in the modal.`,
      `- Auto-creates the proposal on emit. After it, tell the owner you've queued it and they can deploy it from the Approvals window. Do NOT write a fake "✓" — the runtime appends the receipt.`,
      ``,
      `[[OCCA:PROPOSE_DEPLOYMENT]]`,
      `{`,
      `  "role": "<key from PROPOSABLE ROLES above>",`,
      `  "runtime": "<type from PROPOSABLE RUNTIMES above>",`,
      `  "skills": ["<optional keys from INSTALLABLE SKILL CATALOG above>"],`,
      `  "suggestedName": "<optional display name>"`,
      `}`,
      `[[/OCCA:PROPOSE_DEPLOYMENT]]`,
    ].join("\n"),
  },
  PROPOSE_PROFILE_EDIT: {
    token: "PROPOSE_PROFILE_EDIT",
    tier: "with_approval",
    approvalActionType: "edit_company_profile",
    run: handleProposeProfileEditBlock,
    executeOnApprove: applyProfileEditApproval,
    promptSpec: [
      `PROPOSE_PROFILE_EDIT MARKER (use when the owner asks to change the company profile — tagline, niche, brand voice, mission, vision, audience, offering, contact, links, or chains covered):`,
      `- This does NOT write. It creates a PROPOSAL the owner reviews and commits in the Approvals window. Until they approve, nothing changes.`,
      `- Include ONLY the fields you want to change; omit the rest. At least one field is required.`,
      `- You CANNOT change the payout wallet address — that is operator-only. Do NOT include it; it is ignored. If the owner asks to change the wallet, tell them to do it themselves in the Company window.`,
      `- Array fields (contentPillars, forbiddenWords, usps, serviceCatalog, chainsCovered) REPLACE the whole list, they do not append — pass the full intended list.`,
      `- After emitting, tell the owner you've queued the change for their approval. Do NOT write a fake "✓" — the runtime appends the receipt.`,
      ``,
      `[[OCCA:PROPOSE_PROFILE_EDIT]]`,
      `{`,
      `  "tagline": "<optional>",`,
      `  "niche": "<optional>",`,
      `  "brandVoice": "<optional>",`,
      `  "mission": "<optional>",`,
      `  "vision": "<optional>",`,
      `  "targetAudience": "<optional>",`,
      `  "coverageScope": "<optional>",`,
      `  "coverageExcluded": "<optional>",`,
      `  "coreOffering": "<optional>",`,
      `  "contentPillars": ["<optional full list>"],`,
      `  "forbiddenWords": ["<optional full list>"],`,
      `  "usps": ["<optional full list>"],`,
      `  "serviceCatalog": ["<optional full list>"],`,
      `  "chainsCovered": ["<optional full list>"],`,
      `  "contactEmail": "<optional>",`,
      `  "salesEmail": "<optional>",`,
      `  "phone": "<optional>",`,
      `  "websiteUrl": "<optional>",`,
      `  "blogUrl": "<optional>",`,
      `  "newsletterUrl": "<optional>",`,
      `  "docsUrl": "<optional>",`,
      `  "logoUrl": "<optional>"`,
      `}`,
      `[[/OCCA:PROPOSE_PROFILE_EDIT]]`,
    ].join("\n"),
  },
  PROPOSE_KNOWLEDGE_EDIT: {
    token: "PROPOSE_KNOWLEDGE_EDIT",
    tier: "with_approval",
    approvalActionType: "edit_knowledge",
    run: handleProposeKnowledgeEditBlock,
    executeOnApprove: applyKnowledgeEditApproval,
    promptSpec: [
      `PROPOSE_KNOWLEDGE_EDIT MARKER (use when the owner asks to add, change, or remove a Company Brain knowledge file — the company's glossary, ICP, style notes, owner preferences, etc.):`,
      `- This does NOT write. It creates a PROPOSAL the owner reviews and commits in the Approvals window. Until they approve, nothing changes.`,
      `- "op" is one of: "create" (new file), "update" (change an existing file), "delete" (remove a file).`,
      `- Files are addressed by "path", which MUST be /brain/<slug>.md (lowercase letters, digits, hyphens). Refer to the file by the path the owner names.`,
      `- "visibility" is one of: "all" (every agent), "tier:head" (CEO + Heads), "ceo_only" (CEO only). Omit on create to default to "all".`,
      `- "content" is the FULL markdown body and REPLACES the file's content — it does not append. On create, content is required; on update, include content only if changing the body.`,
      `- For "update", include at least one of content or visibility. For "delete", only the path is needed.`,
      `- After emitting, tell the owner you've queued the change for their approval. Do NOT write a fake "✓" — the runtime appends the receipt.`,
      ``,
      `[[OCCA:PROPOSE_KNOWLEDGE_EDIT]]`,
      `{`,
      `  "op": "create",`,
      `  "path": "/brain/<slug>.md",`,
      `  "content": "<full markdown body>",`,
      `  "visibility": "all"`,
      `}`,
      `[[/OCCA:PROPOSE_KNOWLEDGE_EDIT]]`,
    ].join("\n"),
  },
  PROPOSE_ROUTINE_EDIT: {
    token: "PROPOSE_ROUTINE_EDIT",
    tier: "with_approval",
    approvalActionType: "edit_routine",
    run: handleProposeRoutineEditBlock,
    executeOnApprove: applyRoutineEditApproval,
    promptSpec: [
      `PROPOSE_ROUTINE_EDIT MARKER (use when the owner asks to change an existing routine's mandate — its title, description, or priority — or to delete a routine):`,
      `- This does NOT write. It creates a PROPOSAL the owner reviews and commits in the Approvals window. Until they approve, nothing changes.`,
      `- "op" is "update" (change title/description/priority) or "delete" (remove the routine).`,
      `- Address the routine by "routineId" — copy the exact id from the COMPANY ROUTINES section of your context. Do NOT guess it.`,
      `- This marker does NOT pause/resume (use TOGGLE_ROUTINE), reassign (use ASSIGN_ROUTINE), run now (use DISPATCH_ROUTINE), or change the schedule/triggers. Use it only for mandate edits, workflow binding, + delete.`,
      `- For "update", include at least one of title, description, priority, or workflowYamlId.`,
      `- "workflowYamlId" binds a sequential workflow so each fire runs that pipeline instead of the mandate; pass "" to clear the binding back to mandate mode.`,
      `- After emitting, tell the owner you've queued the change for their approval. Do NOT write a fake "✓" — the runtime appends the receipt.`,
      ``,
      `[[OCCA:PROPOSE_ROUTINE_EDIT]]`,
      `{`,
      `  "op": "update",`,
      `  "routineId": "<uuid from COMPANY ROUTINES>",`,
      `  "description": "<optional new mandate text>"`,
      `}`,
      `[[/OCCA:PROPOSE_ROUTINE_EDIT]]`,
    ].join("\n"),
  },
  PROPOSE_ROUTINE_CREATE: {
    token: "PROPOSE_ROUTINE_CREATE",
    tier: "with_approval",
    approvalActionType: "create_routine",
    run: handleProposeRoutineCreateBlock,
    executeOnApprove: applyRoutineCreateApproval,
    promptSpec: [
      `PROPOSE_ROUTINE_CREATE MARKER (use when the owner asks to set up a new scheduled routine — a recurring wake on a cron schedule):`,
      `- This does NOT write. It creates a PROPOSAL the owner reviews and commits in the Approvals window. Until they approve, nothing changes.`,
      `- "title" names the routine. "assignee" is "role:<role>" (preferred, e.g. role:head_editorial) or an exact agent name from your context.`,
      `- "cron" is a standard 5-field cron expression (e.g. "0 9 * * *" for 9am daily, "*/30 * * * *" every 30 minutes). "timezone" is an optional IANA zone (e.g. "Asia/Jakarta"), default UTC.`,
      `- Provide EITHER a "mandate" (free-form instruction the assignee runs each fire) OR a "workflowYamlId" (a sequential pipeline from COMPANY WORKFLOWS that runs instead). At least one is required.`,
      `- After emitting, tell the owner you've queued the new routine for their approval. Do NOT write a fake "✓".`,
      ``,
      `[[OCCA:PROPOSE_ROUTINE_CREATE]]`,
      `{`,
      `  "title": "News cycle",`,
      `  "assignee": "role:head_editorial",`,
      `  "cron": "*/30 * * * *",`,
      `  "workflowYamlId": "<id from COMPANY WORKFLOWS, optional>"`,
      `}`,
      `[[/OCCA:PROPOSE_ROUTINE_CREATE]]`,
    ].join("\n"),
  },
  PROPOSE_SKILL_LIBRARY_EDIT: {
    token: "PROPOSE_SKILL_LIBRARY_EDIT",
    tier: "with_approval",
    approvalActionType: "edit_skill_library",
    run: handleProposeSkillLibraryEditBlock,
    executeOnApprove: applySkillLibraryEditApproval,
    promptSpec: [
      `PROPOSE_SKILL_LIBRARY_EDIT MARKER (use when the owner asks to import a new skill into the company library, change which roles may use a library skill, or remove a skill from the library):`,
      `- This does NOT write. It creates a PROPOSAL the owner reviews and commits in the Approvals window. Until they approve, nothing changes.`,
      `- "op" is "import" (bring a new GitHub-sourced skill into the library), "set_roles" (replace the skill's allowed-roles whitelist) or "remove" (delete the skill from the library).`,
      `- Address the skill by "skillKey" — its canonical key (owner/repo/slug), the same key used to install it onto an agent.`,
      `- For "import": skillKey is the skill's GitHub location. Only propose a key the owner gave you or one you can see in your context — NEVER invent one. Optional "allowedRoles" sets the initial whitelist (omit or [] = every role). Once approved, the skill appears in the INSTALLABLE SKILL CATALOG and you can INSTALL_SKILL it onto agents.`,
      `- "import" also REFRESHES: re-importing a key already in the catalog re-fetches it from GitHub and updates the library copy to the latest version. Use it when the owner asks to update a skill to its latest version.`,
      `- For "set_roles": "allowedRoles" REPLACES the whole whitelist. An empty array [] means unrestricted (every role may bind it); a non-empty array limits binding to those roles.`,
      `- "set_roles" / "remove" target only company-imported skills. You CANNOT edit or remove platform built-in skills. Installing/uninstalling a skill onto a specific agent is a different, separate marker.`,
      `- After emitting, tell the owner you've queued the change for their approval. Do NOT write a fake "✓" — the runtime appends the receipt.`,
      ``,
      `[[OCCA:PROPOSE_SKILL_LIBRARY_EDIT]]`,
      `{`,
      `  "op": "import" | "set_roles" | "remove",`,
      `  "skillKey": "<owner/repo/slug>",`,
      `  "allowedRoles": ["<role>", "<role>"]`,
      `}`,
      `[[/OCCA:PROPOSE_SKILL_LIBRARY_EDIT]]`,
    ].join("\n"),
  },
  PROPOSE_TOOL_EDIT: {
    token: "PROPOSE_TOOL_EDIT",
    tier: "with_approval",
    approvalActionType: "edit_tool",
    run: handleProposeToolEditBlock,
    executeOnApprove: applyToolEditApproval,
    promptSpec: [
      `PROPOSE_TOOL_EDIT MARKER (use when the owner asks to change which roles may use a tool, or to delete a tool):`,
      `- This does NOT write. It creates a PROPOSAL the owner reviews and commits in the Approvals window. Until they approve, nothing changes.`,
      `- "op" is "set_roles" (replace the tool's allowed-roles whitelist), "set_status" (pause or activate the tool), or "delete" (remove the tool).`,
      `- For "set_status": "status" is "paused" (reject invocations, keep config) or "active".`,
      `- Address the tool by "toolId" — copy the exact id from your context. Do NOT guess it.`,
      `- For "set_roles": "allowedRoles" REPLACES the whole whitelist. Empty array [] = unrestricted (every role may use it); non-empty limits use to those roles.`,
      `- You CANNOT enter or change the tool's credentials (operator-only) or its configuration here. Binding a tool onto a specific agent is a different, separate marker.`,
      `- After emitting, tell the owner you've queued the change for their approval. Do NOT write a fake "✓" — the runtime appends the receipt.`,
      ``,
      `[[OCCA:PROPOSE_TOOL_EDIT]]`,
      `{`,
      `  "op": "set_roles",`,
      `  "toolId": "<uuid from your context>",`,
      `  "allowedRoles": ["<role>", "<role>"]`,
      `}`,
      `[[/OCCA:PROPOSE_TOOL_EDIT]]`,
    ].join("\n"),
  },
  PROPOSE_WORKFLOW_DELETE: {
    token: "PROPOSE_WORKFLOW_DELETE",
    tier: "with_approval",
    approvalActionType: "delete_workflow",
    run: handleProposeWorkflowDeleteBlock,
    executeOnApprove: applyWorkflowDeleteApproval,
    promptSpec: [
      `PROPOSE_WORKFLOW_DELETE MARKER (use when the owner asks to delete a workflow):`,
      `- This does NOT write. It creates a PROPOSAL the owner reviews and commits in the Approvals window. Until they approve, nothing changes.`,
      `- Address the workflow by "workflowYamlId" — its stable id from the COMPANY WORKFLOWS section of your context (the same id you'd use to enable/disable it).`,
      `- To enable/disable a workflow WITHOUT deleting, use the autonomous toggle instead — do not propose a delete for that.`,
      `- After emitting, tell the owner you've queued the deletion for their approval. Do NOT write a fake "✓" — the runtime appends the receipt.`,
      ``,
      `[[OCCA:PROPOSE_WORKFLOW_DELETE]]`,
      `{ "workflowYamlId": "<id from COMPANY WORKFLOWS>" }`,
      `[[/OCCA:PROPOSE_WORKFLOW_DELETE]]`,
    ].join("\n"),
  },
  PROPOSE_WORKFLOW_CREATE: {
    token: "PROPOSE_WORKFLOW_CREATE",
    tier: "with_approval",
    approvalActionType: "create_workflow",
    run: handleProposeWorkflowCreateBlock,
    executeOnApprove: applyWorkflowCreateApproval,
    promptSpec: [
      `PROPOSE_WORKFLOW_CREATE MARKER (use when the owner asks to add a new workflow/pipeline):`,
      `- This does NOT write. It creates a PROPOSAL the owner reviews and commits in the Approvals window. Until they approve, nothing changes.`,
      `- "yamlText" is the FULL workflow definition as YAML — the same format the owner authors by hand. The workflow's own "id:" field becomes its stable id and must be unique in the company.`,
      `- A workflow is a flat list of "steps". "execution: parallel" (default) fans all steps out at once when a matching task completes; "execution: sequential" runs them one at a time under a shared parent (used for pipelines).`,
      `- Each step has a "title" and "assigned_to". Prefer "assigned_to: role:<role>" (e.g. role:news_writer) so it resolves by function tag across environments; "human" leaves it unassigned.`,
      `- "trigger" is required by the format: { "when": "task.completed", "match": { "task_type": "other" } }.`,
      `- Author the YAML carefully; if it does not parse the proposal is rejected. After emitting, tell the owner you've queued the new workflow for approval. Do NOT write a fake "✓".`,
      ``,
      `[[OCCA:PROPOSE_WORKFLOW_CREATE]]`,
      `{ "yamlText": "id: my-pipeline\\nname: My pipeline\\nexecution: sequential\\ntrigger:\\n  when: task.completed\\n  match:\\n    task_type: other\\nsteps:\\n  - title: \\"First step\\"\\n    assigned_to: role:news_writer\\n  - title: \\"Second step\\"\\n    assigned_to: role:verification_editor" }`,
      `[[/OCCA:PROPOSE_WORKFLOW_CREATE]]`,
    ].join("\n"),
  },
  PROPOSE_WORKFLOW_EDIT: {
    token: "PROPOSE_WORKFLOW_EDIT",
    tier: "with_approval",
    approvalActionType: "edit_workflow",
    run: handleProposeWorkflowEditBlock,
    executeOnApprove: applyWorkflowEditApproval,
    promptSpec: [
      `PROPOSE_WORKFLOW_EDIT MARKER (use when the owner asks to change an existing workflow — rewrite its steps or enable/disable it):`,
      `- This does NOT write. It creates a PROPOSAL the owner reviews and commits in the Approvals window. Until they approve, nothing changes.`,
      `- Address the workflow by "workflowYamlId" — its stable id from the COMPANY WORKFLOWS section of your context.`,
      `- Provide at least one of: "yamlText" (the FULL replacement definition, same format as create) and/or "enabled" (true/false to turn it on/off).`,
      `- If you change the steps, send the COMPLETE yamlText, not a fragment — it replaces the whole definition.`,
      `- After emitting, tell the owner you've queued the change for approval. Do NOT write a fake "✓".`,
      ``,
      `[[OCCA:PROPOSE_WORKFLOW_EDIT]]`,
      `{ "workflowYamlId": "<id from COMPANY WORKFLOWS>", "enabled": false }`,
      `[[/OCCA:PROPOSE_WORKFLOW_EDIT]]`,
    ].join("\n"),
  },
  SET_TASK_STATUS: {
    token: "SET_TASK_STATUS",
    tier: "autonomous",
    run: handleSetTaskStatusBlock,
    promptSpec: [
      `SET_TASK_STATUS MARKER (use when the owner asks to move a task on the board — e.g. "send the landing task to review", "mark #42 done", "put it back in todo"):`,
      `- Address the task by "taskId" (uuid) from the ACTIVE BOARD above. Do NOT guess it — if the task the owner means isn't on the board, say so and stop.`,
      `- "status" is one of: "todo", "in_progress", "review", "done", "blocked".`,
      `- Auto-executed, idempotent (re-emitting the current status just re-confirms).`,
      `- The board enforces the same rules as the UI: you CANNOT set "in_progress" by hand (that happens when an agent actually starts work), and you CANNOT reopen a "done" task — completion is final and bills the company. If the owner wants a done task redone, tell them to rerun it from the board.`,
      `- Marking a task "done" from chat bills the company for it, exactly as completing it on the board does. Only do it when the owner clearly means the work is finished.`,
      `- This does NOT delete or archive a task (use PROPOSE_TASK_DELETE for permanent removal). It only moves it between columns.`,
      ``,
      `[[OCCA:SET_TASK_STATUS]]`,
      `{`,
      `  "taskId": "<uuid from ACTIVE BOARD above>",`,
      `  "status": "todo" | "review" | "done" | "blocked"`,
      `}`,
      `[[/OCCA:SET_TASK_STATUS]]`,
    ].join("\n"),
  },
  EDIT_TASK: {
    token: "EDIT_TASK",
    tier: "autonomous",
    run: handleEditTaskBlock,
    promptSpec: [
      `EDIT_TASK MARKER (use when the owner asks to change a task's details — rename it, change priority/type/effort, retag, set or clear a due date, or edit acceptance criteria):`,
      `- Address the task by "taskId" (uuid) from the ACTIVE BOARD above. Do NOT guess it.`,
      `- Include ONLY the fields you want to change; omit the rest. At least one field is required.`,
      `- This does NOT change status (use SET_TASK_STATUS), reassign the task (not supported from chat), or rewrite the task description body. It only edits the metadata fields below.`,
      `- "tags" REPLACES the whole list — pass the full intended set, not just additions.`,
      `- "dueDate" is an ISO-8601 timestamp, or null to clear it. "acceptanceCriteria" is free text, or null to clear it.`,
      `- Auto-executed, no confirmation needed.`,
      ``,
      `[[OCCA:EDIT_TASK]]`,
      `{`,
      `  "taskId": "<uuid from ACTIVE BOARD above>",`,
      `  "title": "<optional new title>",`,
      `  "priority": "<optional: low | medium | high | urgent>",`,
      `  "taskType": "<optional: feature | bug | research | docs | chore | other>",`,
      `  "effortLevel": "<optional: xs | s | m | l | xl>",`,
      `  "tags": ["<optional full replacement list>"],`,
      `  "dueDate": "<optional ISO-8601, or null to clear>",`,
      `  "acceptanceCriteria": "<optional text, or null to clear>"`,
      `}`,
      `[[/OCCA:EDIT_TASK]]`,
    ].join("\n"),
  },
  COMMENT_TASK: {
    token: "COMMENT_TASK",
    tier: "autonomous",
    run: handleCommentTaskBlock,
    promptSpec: [
      `COMMENT_TASK MARKER (use when the owner asks you to leave a note on a task, or to nudge / ping an agent about their task — e.g. "tell Mara to prioritise the launch task", "add a note on #42"):`,
      `- Address the task by "taskId" (uuid) from the ACTIVE BOARD above. Do NOT guess it.`,
      `- "body" is the comment text. To ping a teammate, write @Name using a name EXACTLY as it appears in YOUR ACTIVE TEAM above (case-insensitive). A mentioned teammate who is assigned to this task is re-woken to pick it up; mentioning someone not on this task just records the note.`,
      `- Keep it short and operational: a directive, a status nudge, a hand-off. Not a place for long discussion.`,
      `- Auto-executed. The comment is posted as you (the CEO).`,
      ``,
      `[[OCCA:COMMENT_TASK]]`,
      `{`,
      `  "taskId": "<uuid from ACTIVE BOARD above>",`,
      `  "body": "<comment text, may include @Name from YOUR ACTIVE TEAM>"`,
      `}`,
      `[[/OCCA:COMMENT_TASK]]`,
    ].join("\n"),
  },
  PROPOSE_TASK_DELETE: {
    token: "PROPOSE_TASK_DELETE",
    tier: "with_approval",
    approvalActionType: "delete_task",
    run: handleProposeTaskDeleteBlock,
    executeOnApprove: applyTaskDeleteApproval,
    promptSpec: [
      `PROPOSE_TASK_DELETE MARKER (use when the owner asks to permanently delete a task):`,
      `- This does NOT write. It creates a PROPOSAL the owner reviews and commits in the Approvals window. Until they approve, nothing changes.`,
      `- Address the task by "taskId" (uuid) from your context.`,
      `- Deleting is permanent. If the owner just wants it off the active board, archiving is the softer option (handled elsewhere) — only propose delete when they mean delete.`,
      `- After emitting, tell the owner you've queued the deletion for their approval. Do NOT write a fake "✓" — the runtime appends the receipt.`,
      ``,
      `[[OCCA:PROPOSE_TASK_DELETE]]`,
      `{ "taskId": "<uuid>" }`,
      `[[/OCCA:PROPOSE_TASK_DELETE]]`,
    ].join("\n"),
  },
};

// Map an approvals.actionType back to its CEO action descriptor. Used by the
// approval side-effect dispatcher to find the executeOnApprove for a row.
// Built once from the registry; with-approval actions only.
const CEO_ACTIONS_BY_APPROVAL_TYPE: Record<string, CeoActionDescriptor> =
  Object.fromEntries(
    Object.values(CEO_ACTIONS)
      .filter((a) => a.approvalActionType)
      .map((a) => [a.approvalActionType as string, a]),
  );

export function findCeoActionByApprovalType(
  actionType: string,
): CeoActionDescriptor | undefined {
  return CEO_ACTIONS_BY_APPROVAL_TYPE[actionType];
}
