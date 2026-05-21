// AES-256-GCM encryption helper for tool credentials at rest.
//
// Storage format (the JSON blob in `company_tools.credentials_encrypted`):
//
//   {
//     alg: "aes-256-gcm",
//     iv: "<hex>",          // 12-byte per-row nonce
//     ciphertext: "<hex>",  // encrypted plaintext (UTF-8 JSON)
//     tag: "<hex>",         // 16-byte auth tag
//     kid: "<key-id>"       // which master key encrypted this row
//   }
//
// Key management
// --------------
// Master keys live in env. The primary key id is `OCCA_TOOL_SECRET_KID`,
// and the active key bytes are `OCCA_TOOL_SECRET` (hex-encoded, 32 bytes
// after decoding). Old keys for rotation live as
// `OCCA_TOOL_SECRET_<KID>`. The encrypt path always uses the active key;
// the decrypt path looks up the key by row.kid, falling back through any
// configured retired keys. A future rotation worker re-encrypts rows by
// reading + rewriting them with the active key.
//
// Why GCM and not a fancier scheme: GCM authenticates the ciphertext and
// the IV in one pass, it's in the Node stdlib (`crypto`), and it has a
// well-understood failure mode. We have no need for ratcheting / forward
// secrecy here — these are at-rest tokens, not transcripts.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

export interface EncryptedBlob {
  alg: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  tag: string;
  kid: string;
}

const ALG = "aes-256-gcm" as const;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

// Resolve a key by id. Returns the 32-byte buffer or throws.
function resolveKey(kid: string): Buffer {
  const envName = kid === activeKid() ? "OCCA_TOOL_SECRET" : `OCCA_TOOL_SECRET_${kid}`;
  const hex = process.env[envName];
  if (!hex) {
    throw new Error(`tool-crypto: missing key for kid=${kid} (expected env ${envName})`);
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_LEN) {
    throw new Error(`tool-crypto: key kid=${kid} must decode to ${KEY_LEN} bytes (got ${buf.length})`);
  }
  return buf;
}

function activeKid(): string {
  const kid = process.env.OCCA_TOOL_SECRET_KID;
  if (!kid) {
    throw new Error("tool-crypto: OCCA_TOOL_SECRET_KID env var is not set");
  }
  return kid;
}

// Encrypt a plaintext object (will be JSON.stringify'd) under the active
// key. Returns the storage-shape blob ready to land in jsonb.
export function encryptCredentials(plaintext: unknown): EncryptedBlob {
  const kid = activeKid();
  const key = resolveKey(kid);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const json = JSON.stringify(plaintext);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: ALG,
    iv: iv.toString("hex"),
    ciphertext: encrypted.toString("hex"),
    tag: tag.toString("hex"),
    kid,
  };
}

// Decrypt a stored blob. Returns the original plaintext object (parsed
// from the JSON serialization). Throws on tag mismatch, missing key, or
// any structural issue.
export function decryptCredentials<T = unknown>(blob: EncryptedBlob): T {
  if (blob.alg !== ALG) {
    throw new Error(`tool-crypto: unsupported alg "${blob.alg}"`);
  }
  const iv = Buffer.from(blob.iv, "hex");
  const tag = Buffer.from(blob.tag, "hex");
  const ciphertext = Buffer.from(blob.ciphertext, "hex");
  if (iv.length !== IV_LEN) {
    throw new Error(`tool-crypto: iv must be ${IV_LEN} bytes`);
  }
  if (tag.length !== TAG_LEN) {
    throw new Error(`tool-crypto: tag must be ${TAG_LEN} bytes`);
  }
  const key = resolveKey(blob.kid);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}

// Generate a fresh 32-byte hex key. Used by ops tooling, not at runtime.
export function generateKeyHex(): string {
  return randomBytes(KEY_LEN).toString("hex");
}
