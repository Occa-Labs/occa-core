// Notification deep-link parsing.
//
// Notifications carry an optional `link` string in the canonical form
// "<window>:<id?>". Examples:
//   "approvals:7c064429-7494-4427-b756-ab66e1cf2ca4" — open Approvals
//      window pre-selecting that approval
//   "chain:treasury" — open Chain window, Treasury tab
//   "agents:<id>"     — open Agents window, focused on agent
//
// We keep the format dumb-string instead of a structured object so the
// server doesn't have to know FE routing internals.

export type ParsedNotificationLink = {
  /** "approvals" | "chain" | "agents" | string (forward-compat) */
  window: string;
  /** Optional id/sub-path after the colon. */
  target: string | null;
};

export function parseNotificationLink(
  link: string | null,
): ParsedNotificationLink | null {
  if (!link) return null;
  const idx = link.indexOf(":");
  if (idx === -1) return { window: link, target: null };
  return {
    window: link.slice(0, idx),
    target: link.slice(idx + 1) || null,
  };
}

// Convert the raw createdAt ISO into "5m ago" / "2h ago" / "yesterday".
// Mirrors approvals/utils relativeTime but kept self-contained so the
// notifications feature doesn't import from approvals (cross-feature
// rule).
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, Math.floor((now - then) / 1000));
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
