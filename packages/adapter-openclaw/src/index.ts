// @occa/adapter-openclaw — OpenClaw runtime adapter
//
// OpenClaw-specific terms (protocol v3, Ed25519 device auth, device.pair.*,
// hooksToken, sessionKey) hanya boleh hidup di package ini.

import type {
  AgentAdapter,
  ProbeResult,
  PrepareCredentialsResult,
  AdapterProvisionInput,
  AdapterProvisionResult,
  AdapterDeprovisionInput,
  AdapterSeedInput,
  AdapterSeedResult,
  AdapterSendPromptInput,
  AdapterSendPromptResult,
  AdapterResetSessionInput,
  AdapterResetSessionResult,
} from "@occa/runtime-core";
import { probeConnection } from "./probe";
import { executeTrace } from "./execute";
import { deleteAgentSession } from "./delete-session";
import {
  generateEphemeralKeypair,
  deserializeKeypair,
  serializeKeypair,
  type DeviceIdentity,
  type SerializedKeypair,
} from "./keypair";
import { validateDeviceKeypair } from "./validate";
import { provisionAgent, deprovisionAgent } from "./provision";
import { seedWorkspace as seedWorkspaceRpc } from "./seed-workspace";
import { sendAgentPrompt } from "./chat";

export { probeConnection } from "./probe";
export { executeTrace } from "./execute";
export { validateDeviceKeypair } from "./validate";
export type {
  ValidateKeypairResult,
  ValidateKeypairErrorCode,
} from "./validate";
export {
  provisionAgent,
  deprovisionAgent,
  listGatewayAgents,
} from "./provision";
export type {
  ProvisionAgentInput,
  ProvisionAgentResult,
  ProvisionAgentErrorCode,
  DeprovisionAgentInput,
  DeprovisionAgentResult,
  ListGatewayAgentsInput,
  ListGatewayAgentsResult,
} from "./provision";
export { seedWorkspace } from "./seed-workspace";
export { deleteAgentSession } from "./delete-session";
export type {
  DeleteSessionInput,
  DeleteSessionResult,
  DeleteSessionErrorCode,
} from "./delete-session";
export {
  chatWithAgent,
  sendAgentPrompt,
  fireAgentPrompt,
  checkAgentRun,
} from "./chat";
export type {
  ChatWithAgentInput,
  ChatWithAgentResult,
  ChatErrorCode,
  SendAgentPromptInput,
  AgentPromptResult,
  AgentPromptErrorCode,
  FireAgentPromptResult,
  CheckAgentRunInput,
  CheckAgentRunResult,
} from "./chat";
export type {
  SeedWorkspaceInput,
  SeedWorkspaceResult,
  SeedWorkspaceErrorCode,
  WorkspaceFileInput,
} from "./seed-workspace";
export {
  generateEphemeralKeypair,
  serializeKeypair,
  deserializeKeypair,
} from "./keypair";
export type { DeviceIdentity, SerializedKeypair } from "./keypair";
export type {
  OpenClawProbeResult,
  OpenClawProbeErrorCode,
} from "@occa/runtime-core";

export const openclawAdapter: AgentAdapter = {
  type: "openclaw",

  // ── Connection check ──────────────────────────────────────────────────────
  async probeConnection(config): Promise<ProbeResult> {
    const c = config as Record<string, unknown>;
    const gatewayUrl = c.gatewayUrl;
    const apiKey = c.apiKey;
    if (typeof gatewayUrl !== "string" || typeof apiKey !== "string") {
      return { ok: false, latencyMs: 0, error: "config_invalid" };
    }

    // Use the agent's persistent device identity + previously-issued device
    // token when present, so background probes (e.g. connection-probe loop)
    // don't generate a fresh ephemeral keypair on every tick — that pattern
    // produced a new pending-pair request every 90s and forced the user to
    // re-approve OCCA repeatedly.
    let device: DeviceIdentity | undefined;
    const storedKeypair = c.deviceKeypair as
      | SerializedKeypair
      | null
      | undefined;
    if (
      storedKeypair &&
      typeof storedKeypair.deviceId === "string" &&
      typeof storedKeypair.publicKey === "string" &&
      typeof storedKeypair.privateKeyHex === "string"
    ) {
      device = deserializeKeypair(storedKeypair);
    }
    const deviceToken =
      typeof c.deviceToken === "string" ? c.deviceToken : undefined;

    const res = await probeConnection(
      { gatewayUrl, apiKey },
      { device, deviceToken },
    );
    return {
      ok: res.ok,
      latencyMs: res.latencyMs,
      error: res.error,
      info: res.info as Record<string, unknown> | undefined,
    };
  },

  // ── Provision lifecycle ───────────────────────────────────────────────────
  async prepareCredentials(baseConfig): Promise<PrepareCredentialsResult> {
    const cfg = baseConfig as Record<string, unknown>;
    if (typeof cfg.gatewayUrl !== "string" || typeof cfg.apiKey !== "string") {
      return {
        ok: false,
        error: "config_invalid",
        reason: "gatewayUrl and apiKey are required",
      };
    }
    // If caller already passed a paired device identity (e.g. kickoff-service
    // sharing CEO's keypair, or agent-create augmenting from existing
    // company agent), validate with that instead of generating a fresh
    // ephemeral pair. Without this, every new hire forces re-pairing on
    // the gateway side — the exact UX bug the device-token reuse pattern
    // was designed to avoid.
    const existingKeypair = cfg.deviceKeypair as
      | SerializedKeypair
      | null
      | undefined;
    const existingToken =
      typeof cfg.deviceToken === "string" ? cfg.deviceToken : undefined;
    const reuseExisting =
      !!existingKeypair &&
      typeof existingKeypair.deviceId === "string" &&
      typeof existingKeypair.publicKey === "string" &&
      typeof existingKeypair.privateKeyHex === "string";

    const keypair = reuseExisting
      ? deserializeKeypair(existingKeypair)
      : await generateEphemeralKeypair();
    const validate = await validateDeviceKeypair(
      { gatewayUrl: cfg.gatewayUrl, apiKey: cfg.apiKey },
      keypair,
      existingToken ? { deviceToken: existingToken } : undefined,
    );
    if (!validate.ok) {
      return { ok: false, error: validate.error, reason: validate.reason };
    }
    return {
      ok: true,
      configPatch: {
        deviceKeypair: serializeKeypair(keypair),
        ...(validate.deviceToken
          ? { deviceToken: validate.deviceToken }
          : existingToken
            ? { deviceToken: existingToken }
            : {}),
      },
    };
  },

  async provision(
    input: AdapterProvisionInput,
  ): Promise<AdapterProvisionResult> {
    const cfg = input.adapterConfig;
    if (
      typeof cfg.gatewayUrl !== "string" ||
      typeof cfg.apiKey !== "string" ||
      !cfg.deviceKeypair
    ) {
      return {
        ok: false,
        error: "config_invalid",
        reason: "gatewayUrl, apiKey, deviceKeypair required",
      };
    }
    const device = deserializeKeypair(cfg.deviceKeypair as SerializedKeypair);
    const result = await provisionAgent({
      gatewayUrl: cfg.gatewayUrl,
      apiKey: cfg.apiKey,
      device,
      deviceToken:
        typeof cfg.deviceToken === "string" ? cfg.deviceToken : undefined,
      desiredId: input.desiredExternalId,
      workspacePath: input.workspacePath,
    });
    if (!result.ok) {
      return { ok: false, error: result.error, reason: result.reason };
    }
    return {
      ok: true,
      externalAgentId: result.externalAgentId,
      workspacePath: result.workspacePath,
      configPatch: {
        openclawAgentId: result.externalAgentId,
        workspacePath: result.workspacePath,
        ...(result.deviceToken ? { deviceToken: result.deviceToken } : {}),
      },
    };
  },

  async deprovision(input: AdapterDeprovisionInput): Promise<void> {
    const cfg = input.adapterConfig;
    if (
      typeof cfg.gatewayUrl !== "string" ||
      typeof cfg.apiKey !== "string" ||
      !cfg.deviceKeypair
    ) {
      return; // nothing to deprovision if config is incomplete
    }
    const device = deserializeKeypair(cfg.deviceKeypair as SerializedKeypair);
    await deprovisionAgent({
      gatewayUrl: cfg.gatewayUrl,
      apiKey: cfg.apiKey,
      device,
      externalAgentId: input.externalAgentId,
    });
  },

  async seedWorkspace(input: AdapterSeedInput): Promise<AdapterSeedResult> {
    const cfg = input.adapterConfig;
    if (
      typeof cfg.gatewayUrl !== "string" ||
      typeof cfg.apiKey !== "string" ||
      !cfg.deviceKeypair
    ) {
      return {
        ok: false,
        error: "config_invalid",
        reason: "gatewayUrl, apiKey, deviceKeypair required",
      };
    }
    const device = deserializeKeypair(cfg.deviceKeypair as SerializedKeypair);
    return seedWorkspaceRpc({
      gatewayUrl: cfg.gatewayUrl,
      apiKey: cfg.apiKey,
      device,
      externalAgentId: input.externalAgentId,
      files: input.files,
    });
  },

  // ── Task execution ────────────────────────────────────────────────────────
  async sendPrompt(
    input: AdapterSendPromptInput,
  ): Promise<AdapterSendPromptResult> {
    const cfg = input.adapterConfig;
    if (
      typeof cfg.gatewayUrl !== "string" ||
      typeof cfg.apiKey !== "string" ||
      !cfg.deviceKeypair
    ) {
      return {
        ok: false,
        error: "config_invalid",
        reason: "gatewayUrl, apiKey, deviceKeypair required",
      };
    }
    const device = deserializeKeypair(cfg.deviceKeypair as SerializedKeypair);
    return sendAgentPrompt(
      {
        gatewayUrl: cfg.gatewayUrl,
        apiKey: cfg.apiKey,
        device,
        sessionKey: input.sessionKey,
        message: input.message,
        onEvent: input.onEvent
          ? (evt) => input.onEvent!(evt.stream, evt.data)
          : undefined,
      },
      { waitTimeoutMs: input.waitTimeoutMs },
    );
  },

  async resetSession(
    input: AdapterResetSessionInput,
  ): Promise<AdapterResetSessionResult> {
    const cfg = input.adapterConfig;
    if (
      typeof cfg.gatewayUrl !== "string" ||
      typeof cfg.apiKey !== "string" ||
      !cfg.deviceKeypair
    ) {
      return {
        ok: false,
        error: "config_invalid",
        reason: "gatewayUrl, apiKey, deviceKeypair required",
      };
    }
    const device = deserializeKeypair(cfg.deviceKeypair as SerializedKeypair);
    return deleteAgentSession({
      gatewayUrl: cfg.gatewayUrl,
      apiKey: cfg.apiKey,
      device,
      deviceToken:
        typeof cfg.deviceToken === "string" ? cfg.deviceToken : undefined,
      sessionKey: input.sessionKey,
    });
  },

  executeTrace,
};
