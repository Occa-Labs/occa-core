#!/usr/bin/env tsx
// Smoke test for the Tools primitive in-memory layer.
//
// Verifies:
//   - Catalog loads every YAML in catalog/ and validates against the
//     entry schema (no duplicates, no bad shapes)
//   - Each catalog entry's credentialFields aligns with the dispatched
//     handler/MCP expectations
//   - Encryption roundtrip via the active master key works
//   - toCatalogWireEntry produces a wire-shape entry
//
// Does NOT touch the DB or hit any external API. Useful as a fast
// post-edit sanity check.
//
// Usage:
//
//   pnpm tsx scripts/smoke-tools.ts

import { z } from "zod";
import {
  encryptCredentials,
  decryptCredentials,
  generateKeyHex,
} from "../src/lib/tool-crypto";
import {
  listCatalog,
  findCatalogEntry,
} from "../src/features/tools/services/catalog-loader";
import { findEmbeddedHandler } from "../src/features/tools/handlers/embedded-handlers";
import { toCatalogWireEntry } from "../src/features/tools/routes/_shared";

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log("        ", detail);
    fail++;
  }
}

async function main() {
  // === 1. Catalog load ===

  console.log("[1] Catalog load");
  const entries = await listCatalog();
  check(
    "at least one catalog entry registered",
    entries.length >= 1,
    entries.length,
  );
  const x = await findCatalogEntry("x");
  check("x entry resolvable by type", x !== null);
  const mcp = await findCatalogEntry("mcp");
  check("mcp custom escape hatch entry exists", mcp !== null);

  if (x) {
    check(
      "x has at least one credentialField",
      x.credentialFields.length > 0,
      x.credentialFields.length,
    );
    check(
      "x has implementation embedded",
      x.implementation.kind === "embedded",
    );
    check(
      "x.actions has at least one entry",
      x.actions.length > 0,
      x.actions,
    );
  }

  if (mcp) {
    check(
      "mcp has implementation mcp",
      mcp.implementation.kind === "mcp",
    );
    check(
      "mcp has hasDynamicActions=true",
      mcp.hasDynamicActions === true,
    );
  }

  // === 2. Embedded handler resolution ===

  console.log("");
  console.log("[2] Embedded handler resolution");
  if (x && x.implementation.kind === "embedded") {
    const handler = findEmbeddedHandler(x.implementation.handler);
    check(
      `${x.implementation.handler} embedded handler is registered`,
      handler !== null,
    );

    if (handler && handler.credentialsSchema instanceof z.ZodObject) {
      const schemaKeys = Object.keys(handler.credentialsSchema.shape);
      const fieldKeys = x.credentialFields.map((f) => f.name);
      const missing = schemaKeys.filter((k) => !fieldKeys.includes(k));
      const extra = fieldKeys.filter((k) => !schemaKeys.includes(k));
      check(
        "x catalog credentialFields covers handler schema keys",
        missing.length === 0,
        missing,
      );
      check(
        "x catalog credentialFields has no extras",
        extra.length === 0,
        extra,
      );
    }
  }

  // === 3. Encryption roundtrip ===

  console.log("");
  console.log("[3] Encryption roundtrip");

  if (!process.env.OCCA_TOOL_SECRET_KID || !process.env.OCCA_TOOL_SECRET) {
    process.env.OCCA_TOOL_SECRET_KID = "smoke";
    process.env.OCCA_TOOL_SECRET = generateKeyHex();
    console.log("  (using ephemeral OCCA_TOOL_SECRET for smoke test)");
  }

  const plaintext = {
    apiKey: "abc123",
    apiSecret: "topsecret",
    accessToken: "tok-xyz",
    accessTokenSecret: "tok-secret-zzz",
  };
  const blob = encryptCredentials(plaintext);
  check("encrypted blob alg is aes-256-gcm", blob.alg === "aes-256-gcm");
  check("encrypted blob has iv", typeof blob.iv === "string" && blob.iv.length > 0);
  check("encrypted blob has ciphertext", typeof blob.ciphertext === "string" && blob.ciphertext.length > 0);
  check("encrypted blob has tag", typeof blob.tag === "string" && blob.tag.length > 0);
  check("encrypted blob has kid", typeof blob.kid === "string" && blob.kid.length > 0);

  const roundtripped = decryptCredentials<typeof plaintext>(blob);
  check(
    "decrypt returns original object",
    roundtripped.apiKey === plaintext.apiKey &&
      roundtripped.apiSecret === plaintext.apiSecret &&
      roundtripped.accessToken === plaintext.accessToken &&
      roundtripped.accessTokenSecret === plaintext.accessTokenSecret,
  );

  const lastChar = blob.ciphertext.slice(-1);
  const flipped = lastChar === "0" ? "1" : "0";
  const tampered = {
    ...blob,
    ciphertext: blob.ciphertext.slice(0, -1) + flipped,
  };
  let tamperRejected = false;
  try {
    decryptCredentials(tampered);
  } catch {
    tamperRejected = true;
  }
  check("tampered ciphertext is rejected (auth tag)", tamperRejected);

  // === 4. Catalog DTO mapping ===

  console.log("");
  console.log("[4] Catalog DTO mapping");
  if (x) {
    const wire = toCatalogWireEntry(x);
    check("wire entry type matches", wire.type === "x");
    check("wire entry has displayName", wire.displayName.length > 0);
    check(
      "wire entry preserves credentialFields",
      wire.credentialFields.length === x.credentialFields.length,
    );
    check(
      "wire entry actions list matches catalog",
      wire.actions.length === x.actions.length,
    );
    check(
      "wire entry flags hasTestConnection",
      wire.hasTestConnection === x.hasTestConnection,
    );
    check(
      "wire entry flags hasDynamicActions",
      wire.hasDynamicActions === x.hasDynamicActions,
    );
  }

  // === Summary ===

  console.log("");
  console.log("─".repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("smoke-tools: unexpected error", err);
  process.exit(1);
});
