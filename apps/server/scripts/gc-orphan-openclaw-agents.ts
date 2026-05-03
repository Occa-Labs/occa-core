#!/usr/bin/env tsx
// One-shot orphan-agent cleanup that does NOT need the OCCA DB to have any
// rows yet. Use this when the DB has been wiped but the OpenClaw gateway
// still holds OCCA-prefixed agents from prior runs.
//
// Usage (from apps/server/):
//
//   GATEWAY_URL=ws://<host>:18789 \
//   GATEWAY_API_KEY=<your-key> \
//   pnpm gc-orphans                                            # dry run
//
//   GATEWAY_URL=... GATEWAY_API_KEY=... CONFIRM=1 pnpm gc-orphans
//
// Optional KEEP env: comma-separated agent ids to preserve regardless of
// prefix. Defaults to "main,test2" so common user-managed entries are safe.
//
// First run on a new device generates an ephemeral keypair and tries
// auto-pair against the gateway. The gateway must allow auto-approve for
// admin devices; otherwise approve via `openclaw devices approve <id>`
// on the gateway host once.

import {
  deprovisionAgent,
  generateEphemeralKeypair,
  listGatewayAgents,
} from "@occa/adapter-openclaw";

const OCCA_PREFIX = "occa-";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const gatewayUrl = envOrThrow("GATEWAY_URL");
  const apiKey = envOrThrow("GATEWAY_API_KEY");
  const confirm = process.env.CONFIRM === "1";
  const keep = new Set(
    (process.env.KEEP ?? "main,test2")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  console.log(`[gc] gateway=${gatewayUrl}`);
  console.log(`[gc] keep list=[${Array.from(keep).join(",")}]`);
  console.log(`[gc] mode=${confirm ? "DELETE" : "dry-run (set CONFIRM=1 to delete)"}`);

  const device = await generateEphemeralKeypair();
  console.log(`[gc] device id=${device.deviceId.slice(0, 12)}…`);

  console.log("[gc] listing gateway agents…");
  const listed = await listGatewayAgents({ gatewayUrl, apiKey, device });
  if (!listed.ok) {
    console.error(
      `[gc] list failed: ${listed.error}${listed.reason ? ` (${listed.reason})` : ""}`,
    );
    process.exit(1);
  }

  console.log(`[gc] gateway has ${listed.agents.length} agent(s):`);
  for (const a of listed.agents) {
    console.log(`     - ${a.id}${a.workspace ? ` (workspace=${a.workspace})` : ""}`);
  }

  // Orphan = OCCA-prefixed AND not in keep list. Without a DB to diff
  // against, we treat ALL `occa-*` ids as candidates — assume the user runs
  // this only when they know there's no live OCCA agent they care about,
  // or has added the live id to KEEP=… explicitly.
  const orphans = listed.agents
    .map((a) => a.id)
    .filter((id) => id.startsWith(OCCA_PREFIX) && !keep.has(id));

  console.log(`[gc] orphan candidates (occa-* not in keep): ${orphans.length}`);
  for (const id of orphans) console.log(`     × ${id}`);

  if (!confirm) {
    console.log("[gc] dry-run complete. Re-run with CONFIRM=1 to delete.");
    return;
  }

  if (orphans.length === 0) {
    console.log("[gc] nothing to delete.");
    return;
  }

  for (const id of orphans) {
    process.stdout.write(`[gc] deprovision ${id} … `);
    const result = await deprovisionAgent({
      gatewayUrl,
      apiKey,
      device,
      externalAgentId: id,
    });
    if (result.ok) {
      console.log("ok");
    } else {
      console.log(`FAIL (${result.error}: ${result.reason ?? "no reason"})`);
    }
  }
  console.log("[gc] done.");
}

main().catch((err) => {
  console.error("[gc] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
