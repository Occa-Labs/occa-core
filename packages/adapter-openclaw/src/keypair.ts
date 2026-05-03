import { createHash } from "node:crypto";
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: Uint8Array;
}

export interface SerializedKeypair {
  deviceId: string;
  publicKey: string;
  privateKeyHex: string;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function fingerprintPublicKey(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

export function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce: string | null;
}): string {
  const version = params.nonce ? "v2" : "v1";
  const parts = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token,
  ];
  if (params.nonce) parts.push(params.nonce);
  return parts.join("|");
}

export async function generateEphemeralKeypair(): Promise<DeviceIdentity> {
  const privateKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  return {
    deviceId: fingerprintPublicKey(publicKey),
    publicKey: base64UrlEncode(publicKey),
    privateKey,
  };
}

export function serializeKeypair(kp: DeviceIdentity): SerializedKeypair {
  return {
    deviceId: kp.deviceId,
    publicKey: kp.publicKey,
    privateKeyHex: Buffer.from(kp.privateKey).toString("hex"),
  };
}

export function deserializeKeypair(s: SerializedKeypair): DeviceIdentity {
  return {
    deviceId: s.deviceId,
    publicKey: s.publicKey,
    privateKey: new Uint8Array(Buffer.from(s.privateKeyHex, "hex")),
  };
}

export async function signPayload(
  payload: string,
  privateKey: Uint8Array,
): Promise<string> {
  const sig = await signAsync(new TextEncoder().encode(payload), privateKey);
  return base64UrlEncode(sig);
}
