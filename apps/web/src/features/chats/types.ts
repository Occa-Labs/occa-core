// Local types for the Chats window. A "party" is either the human user
// or one of their deployments — these are the two participant kinds we
// surface across the user_ceo + agent_dm threads in the chat surface.
//
// The encoded string form ("user" or "agent:<uuid>") is what the inbox
// API accepts as `self` / `partner` query params; see
// `apps/server/.../chat/domain/schemas.ts` for the parsing contract.

export type InboxParty =
  | { kind: "user" }
  | { kind: "deployment"; deploymentId: string };

export function encodeParty(p: InboxParty): string {
  if (p.kind === "user") return "user";
  return `agent:${p.deploymentId}`;
}

export function partyKey(p: InboxParty): string {
  return encodeParty(p);
}

export function partiesEqual(a: InboxParty, b: InboxParty): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "user") return true;
  return a.deploymentId === (b as { deploymentId: string }).deploymentId;
}
