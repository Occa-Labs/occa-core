// User-facing strings for adapter-level error codes.
//
// Both `sendPrompt` and `executeTrace` can fail with codes that are
// adapter-specific (OpenClaw's `gateway_handshake_timeout` /
// `device_pairing_required`, Hermes' `gateway_completion_error` /
// `gateway_completion_timeout`, plus shared codes like
// `gateway_unreachable` / `gateway_unauthorized` / `cancelled`). When we
// surface these to the user via a system chat message, the raw code is
// noise — it leaks adapter vocabulary that the user has no way to
// reason about ("what's a handshake timeout?"). This helper maps the
// known codes onto short, action-oriented sentences and falls back to
// "<subject> couldn't reply just now" for unknowns so we never expose
// a bare code string.
//
// Kept in `lib/` (no Drizzle, no Express) so both chat-handler and
// agent-dm-handler can pull it without a cross-feature import.

export function adapterErrorMessage(args: {
  /** Adapter-emitted error code from `sendPrompt`'s failure result. */
  code: string;
  /** Subject of the failure as the user would name it ("CEO", a Head's name). */
  subject: string;
  /** Raw adapter detail (e.g. the gateway provider error). When present it's
   *  appended as a "Details:" line so the operator can debug without digging
   *  through server logs — the friendly sentence stays the lead. */
  reason?: string | null;
}): string {
  const friendly = friendlyLine(args);
  const detail = args.reason?.trim();
  // Don't repeat the code as detail when the adapter gave no richer reason.
  if (detail && detail !== args.code) {
    return `${friendly}\n\nDetails: ${detail}`;
  }
  return friendly;
}

function friendlyLine(args: { code: string; subject: string }): string {
  const tail = "Try again in a moment.";
  switch (args.code) {
    case "gateway_unreachable":
      return `Couldn't reach ${args.subject}'s runtime. ${tail}`;
    case "gateway_unauthorized":
      return `${args.subject}'s runtime rejected the credentials. Open the Agents window and re-check the adapter config.`;
    case "gateway_handshake_timeout":
      return `${args.subject}'s runtime didn't finish the handshake. ${tail}`;
    case "gateway_invalid_response":
      return `${args.subject}'s runtime returned an unexpected response. ${tail}`;
    case "gateway_completion_error":
      return `${args.subject}'s runtime errored while replying. ${tail}`;
    case "gateway_completion_timeout":
    case "prompt_timed_out":
      return `${args.subject} took too long to reply. ${tail}`;
    case "device_pairing_required":
      return `${args.subject}'s device needs re-pairing. Open the Agents window and run a reprovision.`;
    case "prompt_failed":
      return `${args.subject} couldn't handle the request. ${tail}`;
    case "cancelled":
      return `Request to ${args.subject} was cancelled.`;
    case "config_invalid":
      return `${args.subject}'s adapter config is incomplete. Open the Agents window to finish setup.`;
    case "not_implemented":
      return `${args.subject}'s runtime doesn't support this yet.`;
    default:
      return `${args.subject} couldn't reply just now. ${tail}`;
  }
}
