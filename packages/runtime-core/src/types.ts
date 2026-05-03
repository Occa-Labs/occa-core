// Placeholder types. Actual implementation comes with adapter-openclaw.
// Shapes are OCCA-native (not OpenClaw-specific) — adapter translates.

export interface TaskPayload {
  taskId: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeEvent {
  type: string;
  seq: number;
  payload: Record<string, unknown>;
  emittedAt: string;
}

export interface HealthStatus {
  ok: boolean;
  detail?: string;
}

export type OpenClawProbeErrorCode =
  | "unreachable"
  | "unauthorized"
  | "pairing_required"
  | "invalid_response";

export interface OpenClawProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: OpenClawProbeErrorCode;
  info?: {
    scopes?: string[];
    connId?: string;
    protocol?: number;
    /**
     * Device token issued by the gateway after a successful pair. Caller
     * should persist this and replay on subsequent connects to skip
     * re-pairing prompts.
     */
    deviceToken?: string;
  };
}
