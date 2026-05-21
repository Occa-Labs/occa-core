// Persistent "skip anchor for now" flag for the kickoff batch flow.
//
// Scoped per company (one user can theoretically have multiple in dev /
// post-MVP). Stored in localStorage so a refresh doesn't re-prompt the
// user — but the OS shell still surfaces an `AnchorReminderBanner` so
// they can come back to it whenever they want.
//
// Cleared automatically once every non-CEO agent has confirmed
// deployment on chain (see useSetupWorkflow), so the next refresh after
// a successful late anchor returns to the default un-skipped state.

const SKIP_PREFIX = "occa.kickoff-anchor-skipped:";
// Sticky "kickoff phase has been resolved once" flag. Set when the user
// first lands on the live OS (either by anchoring the kickoff batch or
// explicitly skipping). Used to prevent ad-hoc deployments made AFTER
// kickoff from yanking the user back into KickoffWindow — those agents
// are anchored inline by their own DeployAgentModal flow.
const RESOLVED_PREFIX = "occa.kickoff-resolved:";

function skipKey(companyId: string): string {
  return `${SKIP_PREFIX}${companyId}`;
}
function resolvedKey(companyId: string): string {
  return `${RESOLVED_PREFIX}${companyId}`;
}

export function isKickoffAnchorSkipped(companyId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(skipKey(companyId)) === "1";
  } catch {
    return false;
  }
}

export function markKickoffAnchorSkipped(companyId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(skipKey(companyId), "1");
  } catch {
    /* quota exceeded / private mode — ignore, just won't persist */
  }
}

export function clearKickoffAnchorSkip(companyId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(skipKey(companyId));
  } catch {
    /* ignore */
  }
}

export function isKickoffResolved(companyId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(resolvedKey(companyId)) === "1";
  } catch {
    return false;
  }
}

export function markKickoffResolved(companyId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(resolvedKey(companyId), "1");
  } catch {
    /* ignore */
  }
}

export function clearKickoffResolved(companyId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(resolvedKey(companyId));
  } catch {
    /* ignore */
  }
}
