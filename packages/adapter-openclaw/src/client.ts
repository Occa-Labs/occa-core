import WebSocket from "ws";
import { v4 as uuid } from "uuid";
import { signAsync } from "@noble/ed25519";
import {
  base64UrlEncode,
  buildDeviceAuthPayload,
  type DeviceIdentity,
} from "./keypair";

const PROTOCOL_VERSION = 3;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CLIENT_VERSION = "0.1.0";
const CLIENT_ID = "openclaw-control-ui";
const ROLE = "operator";
const CLIENT_MODE = "webchat";
const DEFAULT_SCOPES = ["operator.admin"];

export type OpenClawErrorCode =
  | "gateway_unreachable"
  | "gateway_handshake_timeout"
  | "device_pairing_required"
  | "gateway_unauthorized"
  | "gateway_invalid_response";

export interface OpenClawErrorDetail {
  requestId?: string;
  reason?: string;
  raw?: unknown;
}

export class OpenClawError extends Error {
  readonly code: OpenClawErrorCode;
  readonly detail?: OpenClawErrorDetail;

  constructor(code: OpenClawErrorCode, detail?: OpenClawErrorDetail) {
    super(detail?.reason ? `${code}: ${detail.reason}` : code);
    this.name = "OpenClawError";
    this.code = code;
    this.detail = detail;
  }
}

export interface ClientConfig {
  gatewayUrl: string;
  apiKey: string;
  device: DeviceIdentity;
  scopes?: string[];
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  onEvent?: (evt: { event: string; payload: unknown }) => void;
  /**
   * Previously-issued device token from a successful pair. When provided,
   * sent alongside `auth.token` in the connect frame so the gateway can
   * resolve the device without re-prompting for pairing approval.
   */
  deviceToken?: string;
}

export interface HelloOk {
  connId: string | null;
  grantedScopes: string[];
  protocol: number;
  /**
   * Device token issued (or rotated) by the gateway after a successful
   * handshake. When persisted by the caller and replayed on subsequent
   * connects via `ClientConfig.deviceToken`, the gateway recognizes the
   * device without re-prompting the user for pair approval.
   */
  deviceToken?: string;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WireFrame {
  type?: string;
  id?: string;
  event?: string;
  payload?: unknown;
  ok?: boolean;
  error?: unknown;
}

export class OpenClawClient {
  private config: ClientConfig;
  private scopes: string[];
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private connectResolve: ((hello: HelloOk) => void) | null = null;
  private connectReject: ((err: OpenClawError) => void) | null = null;
  private connectRequestId: string | null = null;
  private challengeNonce: string | null = null;
  private connected = false;
  private closed = false;

  constructor(config: ClientConfig) {
    this.config = config;
    this.scopes = config.scopes ?? DEFAULT_SCOPES;
  }

  connect(): Promise<HelloOk> {
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      let ws: WebSocket;
      try {
        const gwUrl = new URL(this.config.gatewayUrl);
        const httpOrigin = gwUrl.origin.replace(/^ws(s?):\/\//, "http$1://");
        ws = new WebSocket(this.config.gatewayUrl, {
          rejectUnauthorized: false,
          headers: { Origin: httpOrigin },
        });
      } catch (err) {
        this.rejectConnect(
          new OpenClawError("gateway_unreachable", {
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }
      this.ws = ws;

      ws.on("open", () => {
        const timeoutMs =
          this.config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
        this.handshakeTimer = setTimeout(() => {
          this.rejectConnect(new OpenClawError("gateway_handshake_timeout"));
          try {
            ws.close(4001, "handshake timeout");
          } catch {
            // ignore
          }
        }, timeoutMs);
      });

      ws.on("message", (data) => {
        let frame: WireFrame;
        const raw = data.toString();
        try {
          frame = JSON.parse(raw);
        } catch {
          if (!this.connected) {
            console.warn(
              `[adapter-openclaw] non-JSON frame during handshake: ${raw.slice(0, 200)}`,
            );
            this.rejectConnect(
              new OpenClawError("gateway_invalid_response", {
                reason: "non-JSON frame during handshake",
              }),
            );
            try {
              ws.close(1008, "invalid frame");
            } catch {
              // ignore
            }
          }
          return;
        }
        this.handleFrame(frame);
      });

      ws.on("close", (code, reason) => {
        const reasonStr = reason?.toString() || "";
        this.clearHandshakeTimer();
        this.rejectAllPending(
          new Error(reasonStr ? `Connection closed: ${reasonStr}` : "Connection closed"),
        );
        if (!this.connected) {
          this.rejectConnect(
            new OpenClawError("gateway_unreachable", {
              reason: `ws closed (${code}) ${reasonStr}`.trim(),
            }),
          );
        }
        this.ws = null;
      });

      ws.on("error", (err) => {
        if (!this.connected) {
          this.rejectConnect(
            new OpenClawError("gateway_unreachable", { reason: err.message }),
          );
        }
      });
    });
  }

  async sendRpc(
    method: string,
    params: unknown = {},
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    if (!this.connected || !this.ws) {
      throw new Error(`Gateway not connected (method=${method})`);
    }
    const id = uuid();
    const timeoutMs =
      options?.timeoutMs ??
      this.config.requestTimeoutMs ??
      DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async close(code = 1000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearHandshakeTimer();
    this.rejectAllPending(new Error("Client closed"));
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      ws.once("close", done);
      try {
        ws.close(code, "client close");
      } catch {
        resolve();
      }
      setTimeout(() => resolve(), 2_000);
    });
  }

  private handleFrame(frame: WireFrame): void {
    if (frame.type === "event") {
      if (frame.event === "connect.challenge") {
        const payload = frame.payload as { nonce?: string } | undefined;
        const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : "";
        if (!nonce) {
          this.rejectConnect(
            new OpenClawError("gateway_invalid_response", {
              reason: "challenge missing nonce",
            }),
          );
          try {
            this.ws?.close(1008, "missing nonce");
          } catch {
            // ignore
          }
          return;
        }
        this.challengeNonce = nonce;
        void this.sendSignedConnect();
        return;
      }
      if (this.connected && this.config.onEvent && typeof frame.event === "string") {
        try {
          this.config.onEvent({ event: frame.event, payload: frame.payload });
        } catch (err) {
          console.warn(
            `[adapter-openclaw] onEvent handler threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return;
    }

    if (frame.type === "res") {
      if (frame.id && frame.id === this.connectRequestId) {
        this.connectRequestId = null;
        if (frame.ok) {
          this.finishHandshake(frame.payload as Record<string, unknown> | undefined);
        } else {
          this.rejectConnectFromRes(frame.error);
        }
        return;
      }
      if (!frame.id) return;
      const p = this.pending.get(frame.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(frame.id);
      if (frame.ok) {
        p.resolve(frame.payload);
      } else {
        const msg =
          typeof frame.error === "string"
            ? frame.error
            : ((frame.error as { message?: string } | undefined)?.message ??
              "RPC error");
        p.reject(new Error(msg));
      }
    }
  }

  private async sendSignedConnect(): Promise<void> {
    if (!this.ws || !this.challengeNonce) return;
    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayload({
      deviceId: this.config.device.deviceId,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: ROLE,
      scopes: this.scopes,
      signedAtMs,
      token: this.config.apiKey,
      nonce: this.challengeNonce,
    });
    const signature = await signAsync(
      new TextEncoder().encode(payload),
      this.config.device.privateKey,
    );
    const params = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: CLIENT_ID,
        version: CLIENT_VERSION,
        platform: process.platform,
        mode: CLIENT_MODE,
      },
      role: ROLE,
      scopes: this.scopes,
      caps: [],
      device: {
        id: this.config.device.deviceId,
        publicKey: this.config.device.publicKey,
        signature: base64UrlEncode(signature),
        signedAt: signedAtMs,
        nonce: this.challengeNonce,
      },
      auth: this.config.deviceToken
        ? { token: this.config.apiKey, deviceToken: this.config.deviceToken }
        : { token: this.config.apiKey },
      userAgent: "occa",
      locale: "en-US",
    };
    const id = uuid();
    this.connectRequestId = id;
    try {
      this.ws.send(JSON.stringify({ type: "req", id, method: "connect", params }));
    } catch (err) {
      this.rejectConnect(
        new OpenClawError("gateway_unreachable", {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private finishHandshake(payload: Record<string, unknown> | undefined): void {
    this.clearHandshakeTimer();
    const server = payload?.server as { connId?: string } | undefined;
    const snapshot = payload?.snapshot as
      | { presence?: Array<{ reason?: string; scopes?: string[] }> }
      | undefined;
    // hello-ok includes auth.deviceToken when the gateway issues (or rotates)
    // a device-scoped token after pair approval. Caller persists this so the
    // next connect can replay it via ClientConfig.deviceToken — that's what
    // prevents the "approve OCCA again" prompt across reconnects.
    const auth = payload?.auth as
      | { deviceToken?: string; role?: string; scopes?: string[] }
      | undefined;
    const selfPresence = snapshot?.presence?.find((p) => p.reason === "connect");
    const grantedScopes = Array.isArray(selfPresence?.scopes)
      ? selfPresence!.scopes
      : [];
    this.connected = true;
    const resolve = this.connectResolve;
    this.connectResolve = null;
    this.connectReject = null;
    resolve?.({
      connId: server?.connId ?? null,
      grantedScopes,
      protocol: PROTOCOL_VERSION,
      deviceToken: auth?.deviceToken,
    });
  }

  private rejectConnectFromRes(error: unknown): void {
    const message =
      typeof error === "string"
        ? error
        : ((error as { message?: string } | undefined)?.message ?? "connect rejected");
    const detailReqId = (error as { detail?: { requestId?: string } } | undefined)
      ?.detail?.requestId;
    const lower = message.toLowerCase();
    let code: OpenClawErrorCode = "gateway_invalid_response";
    if (/pairing|approve|approval|pair_required|device_not_paired/.test(lower))
      code = "device_pairing_required";
    else if (/auth|token|unauthorized|invalid token|forbidden|denied/.test(lower))
      code = "gateway_unauthorized";
    console.warn(
      `[adapter-openclaw] connect rejected: code=${code} message="${message}" raw=${JSON.stringify(error).slice(0, 400)}`,
    );
    this.rejectConnect(
      new OpenClawError(code, { reason: message, requestId: detailReqId, raw: error }),
    );
    try {
      this.ws?.close(1008, message);
    } catch {
      // ignore
    }
  }

  private rejectConnect(err: OpenClawError): void {
    this.clearHandshakeTimer();
    const reject = this.connectReject;
    this.connectReject = null;
    this.connectResolve = null;
    reject?.(err);
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }
}
