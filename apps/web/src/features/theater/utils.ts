import type { AgentStatus, AgentStatusSource } from "./types";

export function deriveAgentStatus(src: AgentStatusSource | null): AgentStatus {
  if (!src) return "connecting";
  if (src.provisioningState === "failed") return "error";
  if (src.provisioningState !== "ready") return "provisioning";
  if (src.connectionState === "disconnected") return "offline";
  if (src.connectionState === "unknown") return "connecting";
  return src.activityState;
}

export function dotColorFor(status: AgentStatus): string {
  switch (status) {
    case "talking":      return "#5fdcff";
    case "working":      return "#00ff88";
    case "meeting":      return "#5fdcff";
    case "idle":         return "#5fdcff";
    case "cooldown":     return "#a78bfa";
    case "connecting":   return "#ffd000";
    case "provisioning": return "#ffd000";
    case "offline":      return "#ff4444";
    case "error":        return "#ff4444";
    default:             return "#888888";
  }
}

export function statusLabelFor(status: AgentStatus): string {
  switch (status) {
    case "talking":      return "Talking";
    case "working":      return "Working";
    case "meeting":      return "Meeting";
    case "idle":         return "Idle";
    case "cooldown":     return "Cooldown";
    case "connecting":   return "Connecting";
    case "provisioning": return "Setting Up";
    case "offline":      return "Offline";
    case "error":        return "Error";
    default:             return "Idle";
  }
}
