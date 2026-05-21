#!/usr/bin/env tsx
// Smoke test for the workflow verification gate.
//
// Reconstructs Task 14's story ("Meteora Overtakes Raydium") as a
// structured claims block and runs it through the verifier against live
// DefiLlama data. Validates that the verifier:
//   - PASSES the six total7d claims the agent reported correctly
//   - PASSES the calculated Meteora-combined sum
//   - FLAGS the three fabricated change_7dover7d numbers as mismatches
//   - FLAGS the hallucinated future date (as_of 2026-07-18)
//   - returns pass === false overall
//
// Needs outbound network (api.llama.fi). No DB.
//
// Usage (from apps/server/):
//
//   pnpm smoke:verification

import { verifyStoryDocument } from "../src/features/workflows/verification/services/verifier";
import type { ClaimStatus } from "../src/features/workflows/verification/domain/schemas";

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

// Task 14's story, rebuilt with a structured claims block. The prose is
// trimmed; what matters is the block. `as_of` is the date Juno actually
// wrote (mis-converted from a Unix timestamp — really 2026-05-18).
const TASK_14_DOC = `# Meteora Overtakes Raydium as Solana's Top DEX Family

Meteora's combined DEX products edged past Raydium AMM in 7-day volume.

<!--occa:claims
{
  "as_of": "2026-07-18",
  "claims": [
    {
      "source": "defillama",
      "id": "solana_dex_7d",
      "label": "Solana total DEX 7d volume",
      "endpoint": "/overview/dexs/solana",
      "selector": "total7d",
      "value": 11362107902
    },
    {
      "source": "defillama",
      "id": "raydium_amm_7d",
      "label": "Raydium AMM 7d volume",
      "endpoint": "/overview/dexs/solana",
      "selector": "protocols[name=Raydium AMM].total7d",
      "value": 1086617203
    },
    {
      "source": "defillama",
      "id": "meteora_dlmm_7d",
      "label": "Meteora DLMM 7d volume",
      "endpoint": "/overview/dexs/solana",
      "selector": "protocols[name=Meteora DLMM].total7d",
      "value": 963681427
    },
    {
      "source": "defillama",
      "id": "meteora_damm_v2_7d",
      "label": "Meteora DAMM V2 7d volume",
      "endpoint": "/overview/dexs/solana",
      "selector": "protocols[name=Meteora DAMM V2].total7d",
      "value": 89975703
    },
    {
      "source": "defillama",
      "id": "meteora_dbc_7d",
      "label": "Meteora DBC 7d volume",
      "endpoint": "/overview/dexs/solana",
      "selector": "protocols[name=Meteora Dynamic Bonding Curve].total7d",
      "value": 33999461
    },
    {
      "source": "defillama",
      "id": "meteora_damm_v1_7d",
      "label": "Meteora DAMM V1 7d volume",
      "endpoint": "/overview/dexs/solana",
      "selector": "protocols[name=Meteora DAMM V1].total7d",
      "value": 10273901
    },
    {
      "source": "defillama",
      "id": "meteora_dlmm_change",
      "label": "Meteora DLMM week-over-week change",
      "endpoint": "/overview/dexs/solana",
      "selector": "protocols[name=Meteora DLMM].change_7dover7d",
      "value": 53.1,
      "abs_tolerance": 2
    },
    {
      "source": "defillama",
      "id": "meteora_damm_v2_change",
      "label": "Meteora DAMM V2 week-over-week change",
      "endpoint": "/overview/dexs/solana",
      "selector": "protocols[name=Meteora DAMM V2].change_7dover7d",
      "value": 59.2,
      "abs_tolerance": 2
    },
    {
      "source": "defillama",
      "id": "raydium_amm_change",
      "label": "Raydium AMM week-over-week change",
      "endpoint": "/overview/dexs/solana",
      "selector": "protocols[name=Raydium AMM].change_7dover7d",
      "value": -21.6,
      "abs_tolerance": 2
    },
    {
      "source": "defillama",
      "id": "solana_tvl",
      "label": "Solana DeFi TVL",
      "endpoint": "/v2/historicalChainTvl/Solana",
      "selector": "latest.tvl",
      "value": 5926959123
    },
    {
      "source": "calculated",
      "id": "meteora_combined_7d",
      "label": "Meteora combined 7d volume",
      "expression": "meteora_dlmm_7d + meteora_damm_v2_7d + meteora_dbc_7d + meteora_damm_v1_7d",
      "value": 1097930492
    }
  ]
}
-->
`;

function statusOf(
  results: { id: string; status: ClaimStatus }[],
  id: string,
): ClaimStatus | "absent" {
  return results.find((r) => r.id === id)?.status ?? "absent";
}

async function main(): Promise<void> {
  console.log("verifying Task 14 story against live DefiLlama...\n");

  // Fixed `now` so the date check is deterministic regardless of when
  // the smoke runs. 2026-05-18 is the real day Task 14 executed.
  const report = await verifyStoryDocument(TASK_14_DOC, {
    now: new Date("2026-05-18T08:00:00Z"),
  });

  console.log("--- per-claim results ---");
  for (const r of report.results) {
    const obs = r.observed === null ? "—" : String(r.observed);
    console.log(
      `  [${r.status.toUpperCase().padEnd(8)}] ${r.label}`,
    );
    console.log(`             claimed=${r.claimed}  observed=${obs}`);
    if (r.detail) console.log(`             ${r.detail}`);
  }
  console.log();

  console.log("--- assertions ---");

  // The hallucinated future date must be flagged.
  check(
    "future as_of (2026-07-18) flagged as dateError",
    report.dateError !== null,
    report.dateError,
  );

  // The three fabricated week-over-week numbers must mismatch.
  for (const id of [
    "meteora_dlmm_change",
    "meteora_damm_v2_change",
    "raydium_amm_change",
  ]) {
    check(`fabricated "${id}" caught as mismatch`, statusOf(report.results, id) === "mismatch");
  }

  // The correctly-reported absolute volumes must pass.
  for (const id of [
    "solana_dex_7d",
    "raydium_amm_7d",
    "meteora_dlmm_7d",
    "meteora_damm_v2_7d",
    "meteora_dbc_7d",
    "meteora_damm_v1_7d",
    "solana_tvl",
  ]) {
    check(`correct "${id}" passes`, statusOf(report.results, id) === "ok");
  }

  // The calculated sum recomputes from verified inputs and passes.
  check(
    'calculated "meteora_combined_7d" passes',
    statusOf(report.results, "meteora_combined_7d") === "ok",
  );

  // Overall verdict must be a fail — the doc is not publishable.
  check("overall verdict is pass === false", report.pass === false);
}

main()
  .then(() => {
    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("smoke test crashed:", err);
    process.exit(1);
  });
